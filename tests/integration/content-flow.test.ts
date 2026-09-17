// Integration: the REAL content.js, imported as a module after its page
// globals (document/window/location/CSS/Event) are pointed at a happy-dom
// window and `chrome` at a tab message target — exactly how background.js
// addresses it via chrome.tabs.sendMessage. Exercises the full message
// contract: tier-gated capture, every action type, and clean error paths.
//
// (content.js is an IIFE with no exports; importing it runs the listener
// registration against whatever globals are installed at import time, so
// each test file imports it with its own cache-busting query string.)

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Window } from "happy-dom";
import { createTabTarget, stubNonZeroRects, FakeEvent, FakePort } from "../helpers/chrome-mock.ts";

/** Point bare browser globals at a happy-dom window + tab target (defineProperty: Bun owns some). */
function setPageGlobals(win: any, chromeObj: any) {
  const g: any = globalThis;
  const pairs: Record<string, any> = {
    chrome: chromeObj,
    document: win.document,
    window: win,
    location: win.location,
    CSS: win.CSS,
    Event: win.Event,
    MutationObserver: win.MutationObserver,
  };
  for (const [name, value] of Object.entries(pairs)) {
    Object.defineProperty(g, name, { value, configurable: true, writable: true });
  }
}

const CONTENT_SRC = readFileSync(resolve(import.meta.dir, "../../extension/content.js"), "utf-8");

/** Execute the real content.js IIFE with a page window baked in as parameters
 * (extension-flow's recipe) — a second instance that doesn't touch globals. */
function loadContentScript(win: any, chromeObj: any) {
  const run = new Function(
    "chrome", "document", "window", "location", "CSS", "Event",
    "MutationObserver", "setTimeout", "clearTimeout", "console",
    CONTENT_SRC,
  );
  run(chromeObj, win.document, win, win.location, win.CSS, win.Event,
    win.MutationObserver, setTimeout, clearTimeout, console);
}

describe("content.js — full-script message flow", () => {  let win: any;
  let target: ReturnType<typeof createTabTarget>;
  let events: string[];

  beforeAll(async () => {
    win = new Window({ url: "https://example.test/article" });
    win.document.write(`<!DOCTYPE html><html><head><title>Test Article</title></head><body>
      <main>
        <h1>Article Heading</h1>
        <p>Some visible article text for capture tests.</p>
        <form>
          <input id="name" name="name" placeholder="Full name" />
          <input id="email" name="email" type="email" />
          <input type="hidden" name="secret" value="h" />
          <select id="plan" name="plan"><option value="pro">Pro</option></select>
          <button id="submit-btn" type="button" data-kind="primary">Submit</button>
        </form>
        <a href="https://example.test/next">Next page</a>
      </main>
    </body></html>`);
    stubNonZeroRects(win);
    events = [];
    win.document.querySelector("#submit-btn").addEventListener("click", () => events.push("submit-click"));
    for (const el of win.document.querySelectorAll("input, select")) {
      el.addEventListener("input", () => events.push(`input:${el.id}:${el.value}`));
      el.addEventListener("change", () => events.push(`change:${el.id}:${el.value}`));
    }
    target = createTabTarget();
    setPageGlobals(win, target.chrome);
    await import("../../extension/content.js?file=content-flow");
  });

  describe("CAPTURE_CONTEXT tier gating", () => {
    it("tier 0: URL/title/viewport only", async () => {
      const ctx = await target.dispatch({ type: "CAPTURE_CONTEXT", tier: 0 });
      expect(ctx.url).toBe("https://example.test/article");
      expect(ctx.title).toBe("Test Article");
      expect(ctx.viewport).toEqual({ w: win.innerWidth, h: win.innerHeight });
      expect(ctx.visibleText).toBeUndefined();
      expect(ctx.formFields).toBeUndefined();
    });

    it("tier 1: adds visibleText from <main>, no elements", async () => {
      const ctx = await target.dispatch({ type: "CAPTURE_CONTEXT", tier: 1 });
      expect(ctx.visibleText).toContain("Some visible article text");
      expect(ctx.formFields).toBeUndefined();
    });

    it("tier 2: adds form fields + clickables with selectors; hidden and zero-rect elements excluded", async () => {
      // Make one field invisible the way the capture path checks (zero rect).
      const email = win.document.querySelector("#email");
      email.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 });
      const ctx = await target.dispatch({ type: "CAPTURE_CONTEXT", tier: 2 });
      const names = ctx.formFields.map((f: any) => f.selector);
      expect(names).toContain("#name");
      expect(names).toContain("#plan");
      expect(names).not.toContain("#email"); // zero-rect → filtered
      expect(ctx.formFields.some((f: any) => f.name === "secret")).toBe(false); // hidden input → filtered
      const clickables = ctx.clickable.map((c: any) => c.text);
      expect(clickables).toContain("Submit");
      expect(clickables).toContain("Next page");
      expect(ctx.documentSize).toBeTruthy();
    });
  });

  describe("EXECUTE_ACTION semantics", () => {
    it("fill sets the value and fires input+change", async () => {
      const res = await target.dispatch({ type: "EXECUTE_ACTION", action: { type: "fill", selector: "#name", value: "Jane Doe" } });
      expect(res).toEqual({ ok: true, type: "fill" });
      expect(win.document.querySelector("#name").value).toBe("Jane Doe");
      expect(events).toContain("input:name:Jane Doe");
      expect(events).toContain("change:name:Jane Doe");
    });

    it("click fires the element's listeners", async () => {
      const res = await target.dispatch({ type: "EXECUTE_ACTION", action: { type: "click", selector: "#submit-btn" } });
      expect(res).toEqual({ ok: true, type: "click" });
      expect(events).toContain("submit-click");
    });

    it("recipe_step waitFor honors a url condition (#267)", async () => {
      const ok = await target.dispatch({ type: "EXECUTE_ACTION", action: { type: "recipe_step", step: { type: "waitFor", url: "example.test/article" } } });
      expect(ok).toEqual({ ok: true, type: "waitFor" });
    });

    it("recipe_step waitFor url timeout is NOT a cue miss (#267)", async () => {
      const res = await target.dispatch({ type: "EXECUTE_ACTION", action: { type: "recipe_step", step: { type: "waitFor", url: "/never.html", timeoutMs: 250 } } });
      expect(res.ok).toBe(false);
      expect(res.cueMiss).toBeUndefined();
      expect(String(res.error)).toContain("never matched");
    }, 5000);

    it("recipe_step click on a sensitive page refuses a form's submit control (#266)", async () => {
      const before = events.filter((e) => e === "submit-click").length;
      const res = await target.dispatch({ type: "EXECUTE_ACTION", action: { type: "recipe_step", sensitive: true, step: { type: "click", cues: [{ strategy: "text", value: "Submit" }] } } });
      expect(res.ok).toBe(false);
      expect(res.refused).toBe("sensitive-submit");
      expect(res.probeText).toBe("Submit");
      expect(events.filter((e) => e === "submit-click").length).toBe(before); // never clicked
    });

    it("recipe_step click on a sensitive page still plays non-submit targets (#266)", async () => {
      const res = await target.dispatch({ type: "EXECUTE_ACTION", action: { type: "recipe_step", sensitive: true, step: { type: "click", cues: [{ strategy: "text", value: "Next page" }] } } });
      expect(res.ok).toBe(true);
      expect(res.refused).toBeUndefined();
    });

    it("extract returns textContent, or an attribute when asked", async () => {
      const res = await target.dispatch({ type: "EXECUTE_ACTION", action: { type: "extract", selector: "#submit-btn" } });
      expect(res.ok).toBe(true);
      expect(res.value).toBe("Submit");
      const attr = await target.dispatch({ type: "EXECUTE_ACTION", action: { type: "extract", selector: "#submit-btn", attribute: "data-kind" } });
      expect(attr.value).toBe("primary");
    });

    it("scroll / wait / navigate / done respond ok without erroring", async () => {
      for (const action of [
        { type: "scroll", direction: "down", amount: 300 },
        { type: "wait", ms: 10 },
        { type: "navigate", url: "https://example.test/next" },
        { type: "done", response: "finished" },
      ]) {
        const res = await target.dispatch({ type: "EXECUTE_ACTION", action });
        expect(res.ok).toBe(true);
        expect(res.type).toBe(action.type);
      }
    });

    it("an actions[] array runs all and aggregates results", async () => {
      const res = await target.dispatch({
        type: "EXECUTE_ACTION",
        actions: [
          { type: "fill", selector: "#plan", value: "pro" },
          { type: "click", selector: "#submit-btn" },
        ],
      });
      expect(res.ok).toBe(true);
      expect(res.results.map((r: any) => r.type)).toEqual(["fill", "click"]);
    });

    it("unknown action type fails cleanly", async () => {
      const res = await target.dispatch({ type: "EXECUTE_ACTION", action: { type: "warp", selector: "#name" } });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Unknown action type: warp");
    });

    it("missing element rejects into a clean error response (after the 5s waitForElement timeout)", async () => {
      const res = await target.dispatch({ type: "EXECUTE_ACTION", action: { type: "click", selector: "#not-there" } });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("#not-there");
    }, 7000);
  });

  describe("message contract edges", () => {
    it("unknown message type responds cleanly (no hanging promise)", async () => {
      const res = await target.dispatch({ type: "SOMETHING_ELSE" });
      expect(res).toEqual({ ok: false, error: "Unknown request type: SOMETHING_ELSE" });
    });
  });

  // Builder-style forms (the "any form" round): live-probed on a Typeform —
  // inputs carry no label/name and share one placeholder; the question text
  // is a plain div, the input wrapper's previous sibling; advance buttons sit
  // outside any <form>. A SECOND content.js instance runs against its own
  // window so the primary page's fixtures stay untouched.
  describe("builder-style forms (#26 any-form)", () => {
    const bWin: any = new Window({ url: "https://example.test/apply" });
    let bTarget: ReturnType<typeof createTabTarget>;

    beforeAll(() => {
      bWin.document.write(`<!DOCTYPE html><html><head><title>Application</title></head><body>
        <div class="app-root">
          <fieldset class="block" data-block="1">
            <div class="block-title">1 Tell us about yourself</div>
            <div class="field">
              <div class="field-title">First name*</div>
              <div class="input-wrap"><input type="text" id="uuid-a1" placeholder="Type your answer here..."></div>
            </div>
            <div class="field">
              <div class="field-title">Work email</div>
              <div class="input-wrap"><input type="email" id="uuid-a2" placeholder="name@example.com"></div>
            </div>
            <button type="button" class="ok-btn">OK</button>
          </fieldset>
          <fieldset class="block" data-block="2">
            <div class="block-title">2 Your links</div>
            <div class="field">
              <div class="field-title">First name*</div>
              <div class="input-wrap"><input type="text" id="uuid-b1" placeholder="Type your answer here..."></div>
            </div>
            <button type="button" class="ok-btn">OK</button>
          </fieldset>
        </div>
      </body></html>`);
      stubNonZeroRects(bWin);
      bTarget = createTabTarget();
      loadContentScript(bWin, bTarget.chrome);
    });

    it("capture joins each field with its question text (title-above-field)", async () => {
      const ctx = await bTarget.dispatch({ type: "CAPTURE_CONTEXT", tier: 2 });
      const bySel = Object.fromEntries(ctx.formFields.map((f: any) => [f.selector, f]));
      expect(bySel["#uuid-a1"].question).toBe("First name*");
      expect(bySel["#uuid-a2"].question).toBe("Work email");
      expect(bySel["#uuid-b1"].question).toBe("First name*"); // innermost title wins over the block title
      expect(ctx.formFields.every((f: any) => f.placeholder === "Type your answer here..." || f.placeholder === "name@example.com")).toBe(true);
    });

    it("never captures sensitive field values (#243 capture redaction)", async () => {
      const pw = bWin.document.createElement("input");
      pw.type = "password";
      pw.id = "pw-field";
      pw.name = "account_password";
      pw.value = "hunter2-secret";
      bWin.document.body.appendChild(pw);
      const card = bWin.document.createElement("input");
      card.type = "text";
      card.id = "card-num";
      card.name = "cc-number";
      card.value = "4111 1111 1111 1111";
      bWin.document.body.appendChild(card);
      bWin.document.querySelector("#uuid-a2").value = "ada@example.test";
      stubNonZeroRects(bWin);

      const ctx = await bTarget.dispatch({ type: "CAPTURE_CONTEXT", tier: 2 });
      const pwField = ctx.formFields.find((f: any) => f.type === "password");
      expect(pwField).toBeTruthy(); // structure still rides (gates the sensitive-form confirm)…
      expect(pwField.value).toBe(""); // …but never the value
      expect(pwField.sensitive).toBe(true);
      const cardField = ctx.formFields.find((f: any) => f.name === "cc-number");
      expect(cardField.value).toBe(""); // name regex match (cc-number) redacts too
      expect(cardField.sensitive).toBe(true);
      // Non-sensitive fields keep their (truncated) value.
      const emailField = ctx.formFields.find((f: any) => f.id === "uuid-a2" || f.name === "uuid-a2" || f.selector.includes("uuid-a2"));
      expect(emailField.value).toBe("ada@example.test");
      expect(emailField.sensitive).toBeUndefined();
    });

    it("fill_form resolves by question text despite identical placeholders", async () => {
      const res = await bTarget.dispatch({
        type: "EXECUTE_ACTION",
        action: { type: "fill_form", values: [
          { target: "First name", value: "Ada Lovelace" }, // undecorated target vs "First name*" cue
          { target: "Work email", value: "ada@example.test" },
        ] },
      });
      expect(res.ok).toBe(true);
      expect(res.fields.map((f: any) => f.ok)).toEqual([true, true]);
      expect(bWin.document.querySelector("#uuid-a1").value).toBe("Ada Lovelace");
      expect(bWin.document.querySelector("#uuid-a2").value).toBe("ada@example.test");
      expect(bWin.document.querySelector("#uuid-b1").value).toBe(""); // the section-2 namesake untouched
    });

    it("a repeated question resolves to the field currently in the viewport", async () => {
      // Section 1 scrolled past (above the viewport), section 2 on screen.
      const a1 = bWin.document.querySelector("#uuid-a1");
      const b1 = bWin.document.querySelector("#uuid-b1");
      a1.getBoundingClientRect = () => ({ width: 200, height: 32, top: -600, left: 0, right: 200, bottom: -568, x: 0, y: -600 });
      const res = await bTarget.dispatch({
        type: "EXECUTE_ACTION",
        action: { type: "fill_form", values: [{ target: "First name", value: "viewport pick" }] },
      });
      expect(res.ok).toBe(true);
      expect(b1.value).toBe("viewport pick");
      expect(a1.value).toBe("Ada Lovelace"); // kept its value from the previous test
    });
  });
});

// Write-assist widget (feature/textarea-fill) — the first page-injected UI. A
// dedicated content.js instance runs against its own happy-dom window with a
// rich chrome (storage + runtime.sendMessage + getURL) so the widget boots.
describe("content.js — write-assist widget", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** Chrome object rich enough for the widget: storage.sync (setting),
   *  runtime.sendMessage (stubbed one-shot), runtime.getURL, onMessage. */
  function makeWidgetChrome(opts: { enabled?: boolean; respond?: (msg: any) => any } = {}) {
    const sent: any[] = [];
    const store: Record<string, any> = { enableWriteAssist: opts.enabled !== false };
    const chromeObj: any = {
      runtime: {
        onMessage: new FakeEvent(),
        sendMessage: (msg: any) => {
          // #220: the recipe recorder peeks once per page load — answered
          // here (disarmed) and excluded from the widget's send log.
          if (msg?.type === "RECIPE_RECORD_PEEK") return Promise.resolve({ ok: true, armed: false });
          sent.push(msg);
          const respond = opts.respond || (() => ({ ok: true, text: "IMPROVED RESULT" }));
          return Promise.resolve(respond(msg));
        },
        getURL: (p: string) => `chrome-extension://test/${p}`,
      },
      storage: {
        sync: {
          get: (keys: any, cb?: Function) => {
            const result: Record<string, any> = {};
            if (keys && typeof keys === "object" && !Array.isArray(keys)) {
              for (const [k, def] of Object.entries(keys)) result[k] = k in store ? store[k] : def;
            }
            if (cb) cb(result);
            return Promise.resolve(result);
          },
        },
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
    };
    return { chromeObj, sent };
  }

  function makeWindow() {
    const win: any = new Window({ url: "https://jobs.example.test/apply" });
    win.document.write(`<!DOCTYPE html><html><head><title>Job Application</title></head><body>
      <label for="proj">Describe your project</label>
      <textarea id="proj" name="proj" placeholder="Tell us about a project" maxlength="500">Led migration of 40 dashboards to DuckDB</textarea>
    </body></html>`);
    stubNonZeroRects(win);
    return win;
  }

  function shadow(win: any) {
    const host = win.document.getElementById("zo-write-assist-host");
    return host ? host.shadowRoot : null;
  }

  it("shows the icon when an eligible textarea is focused", async () => {
    const win = makeWindow();
    const { chromeObj } = makeWidgetChrome();
    loadContentScript(win, chromeObj);
    await tick();
    const ta = win.document.querySelector("#proj");
    ta.focus();
    await tick();
    const root = shadow(win);
    expect(root).toBeTruthy();
    const icon = root.querySelector(".zo-wa-icon");
    expect(icon).toBeTruthy();
    expect(icon.style.display).toBe("flex");
  });

  it("applies the dark theme class when cobrowse_theme is dark (#65)", async () => {
    const win = makeWindow();
    const { chromeObj } = makeWidgetChrome();
    chromeObj.storage.sync.get = (keys: any, cb?: Function) => {
      const result: Record<string, any> = {};
      if (keys && typeof keys === "object" && !Array.isArray(keys)) {
        for (const [k, def] of Object.entries(keys)) result[k] = k === "cobrowse_theme" ? "dark" : def;
      }
      if (cb) cb(result);
      return Promise.resolve(result);
    };
    loadContentScript(win, chromeObj);
    await tick();
    const ta = win.document.querySelector("#proj");
    ta.focus();
    await tick();
    const host = win.document.getElementById("zo-write-assist-host");
    expect(host).toBeTruthy();
    expect(host.classList.contains("zo-wa-dark")).toBe(true);
  });

  it("stays light for explicit light-palette themes (#65)", async () => {
    const win = makeWindow();
    const { chromeObj } = makeWidgetChrome();
    chromeObj.storage.sync.get = (keys: any, cb?: Function) => {
      const result: Record<string, any> = {};
      if (keys && typeof keys === "object" && !Array.isArray(keys)) {
        for (const [k, def] of Object.entries(keys)) result[k] = k === "cobrowse_theme" ? "forest" : def;
      }
      if (cb) cb(result);
      return Promise.resolve(result);
    };
    loadContentScript(win, chromeObj);
    await tick();
    win.document.querySelector("#proj").focus();
    await tick();
    const host = win.document.getElementById("zo-write-assist-host");
    expect(host.classList.contains("zo-wa-dark")).toBe(false);
  });

  it("sends ENHANCE_TEXT with field + page context and previews the result", async () => {
    const win = makeWindow();
    const { chromeObj, sent } = makeWidgetChrome();
    loadContentScript(win, chromeObj);
    await tick();
    const ta = win.document.querySelector("#proj");
    ta.focus();
    await tick();
    const root = shadow(win);
    root.querySelector(".zo-wa-icon").click();
    await tick();
    const pop = root.querySelector(".zo-wa-pop");
    expect(pop.hidden).toBe(false);
    // compose state: instruction input + Enhance button present
    expect(pop.querySelector(".zo-wa-instr")).toBeTruthy();
    const enhanceBtn = [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Enhance");
    expect(enhanceBtn).toBeTruthy();
    enhanceBtn.click();
    await tick();
    await tick();
    // The message carried the lead + field label (from <label for>) + maxLength + page cues.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "ENHANCE_TEXT",
      text: "Led migration of 40 dashboards to DuckDB",
      field: { label: "Describe your project", placeholder: "Tell us about a project", maxLength: 500, markdown: false },
      page: { url: "https://jobs.example.test/apply", title: "Job Application" },
    });
    // result state previews the improved text with Accept/Retry
    const resultBody = pop.querySelector(".zo-wa-result");
    expect(resultBody).toBeTruthy();
    expect(resultBody.textContent).toBe("IMPROVED RESULT");
    const acceptBtn = [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Accept");
    expect(acceptBtn).toBeTruthy();
  });

  it("Accept fills the textarea (framework-safe) and fires input+change", async () => {
    const win = makeWindow();
    const { chromeObj } = makeWidgetChrome();
    loadContentScript(win, chromeObj);
    await tick();
    const ta = win.document.querySelector("#proj");
    const events: string[] = [];
    ta.addEventListener("input", () => events.push(`input:${ta.value}`));
    ta.addEventListener("change", () => events.push(`change:${ta.value}`));
    ta.focus();
    await tick();
    const root = shadow(win);
    root.querySelector(".zo-wa-icon").click();
    await tick();
    const pop = root.querySelector(".zo-wa-pop");
    [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Enhance").click();
    await tick();
    await tick();
    [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Accept").click();
    await tick();
    expect(ta.value).toBe("IMPROVED RESULT");
    expect(events).toContain("input:IMPROVED RESULT");
    expect(events).toContain("change:IMPROVED RESULT");
    // popover closed after accept
    expect(pop.hidden).toBe(true);
  });

  it("renders the error state when the background reports a failure", async () => {
    const win = makeWindow();
    const { chromeObj } = makeWidgetChrome({ respond: () => ({ ok: false, error: "No access token configured." }) });
    loadContentScript(win, chromeObj);
    await tick();
    const ta = win.document.querySelector("#proj");
    ta.focus();
    await tick();
    const root = shadow(win);
    root.querySelector(".zo-wa-icon").click();
    await tick();
    const pop = root.querySelector(".zo-wa-pop");
    [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Enhance").click();
    await tick();
    await tick();
    const errBody = pop.querySelector(".zo-wa-error");
    expect(errBody).toBeTruthy();
    expect(errBody.textContent).toContain("No access token configured");
  });

  it("does not boot when enableWriteAssist is false", async () => {
    const win = makeWindow();
    const { chromeObj } = makeWidgetChrome({ enabled: false });
    loadContentScript(win, chromeObj);
    await tick();
    win.document.querySelector("#proj").focus();
    await tick();
    expect(win.document.getElementById("zo-write-assist-host")).toBeNull();
  });

  it("skips disabled and readonly textareas", async () => {
    const win = makeWindow();
    win.document.body.insertAdjacentHTML("beforeend",
      '<textarea id="dis" disabled>nope</textarea><textarea id="ro" readonly>nope</textarea>');
    const { chromeObj } = makeWidgetChrome();
    loadContentScript(win, chromeObj);
    await tick();
    win.document.querySelector("#dis").focus();
    await tick();
    expect(win.document.getElementById("zo-write-assist-host")).toBeNull();
    win.document.querySelector("#ro").focus();
    await tick();
    expect(win.document.getElementById("zo-write-assist-host")).toBeNull();
  });

  it("works on contenteditable rich editors (GitHub's CodeMirror issue form)", async () => {
    const win = makeWindow();
    win.document.body.insertAdjacentHTML("beforeend",
      '<div id="rich" contenteditable="true" aria-placeholder="Type your description here...">Led migration of 40 dashboards</div>');
    const { chromeObj, sent } = makeWidgetChrome();
    loadContentScript(win, chromeObj);
    await tick();
    const ce = win.document.querySelector("#rich");
    const events: string[] = [];
    ce.addEventListener("input", () => events.push(`input:${ce.textContent}`));
    ce.focus();
    await tick();
    const root = shadow(win);
    expect(root.querySelector(".zo-wa-icon").style.display).toBe("flex");
    root.querySelector(".zo-wa-icon").click();
    await tick();
    const pop = root.querySelector(".zo-wa-pop");
    [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Enhance").click();
    await tick();
    await tick();
    // Lead + placeholder came from the contenteditable (aria-placeholder, not .placeholder);
    // CE fields flag Markdown acceptance.
    expect(sent[0].text).toBe("Led migration of 40 dashboards");
    expect(sent[0].field.placeholder).toBe("Type your description here...");
    expect(sent[0].field.maxLength).toBeNull();
    expect(sent[0].field.markdown).toBe(true);
    // Accept writes back through the textContent fallback (happy-dom has no
    // execCommand; real Chromium uses the execCommand pipeline) + fires input.
    [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Accept").click();
    await tick();
    expect(ce.textContent).toBe("IMPROVED RESULT");
    expect(events).toContain("input:IMPROVED RESULT");
  });

  it("anchors the popover inside a large field; small fields keep the below fallback", async () => {
    const win = makeWindow();
    const { chromeObj } = makeWidgetChrome();
    loadContentScript(win, chromeObj);
    await tick();
    const ta = win.document.querySelector("#proj");

    // Large field (taller than the popover): bottom-aligned INSIDE the rect.
    ta.getBoundingClientRect = () => ({ width: 500, height: 600, top: 50, left: 20, right: 520, bottom: 650, x: 20, y: 50 });
    ta.focus();
    await tick();
    const root = shadow(win);
    root.querySelector(".zo-wa-icon").click();
    await tick();
    let pop = root.querySelector(".zo-wa-pop");
    let top = parseFloat(pop.style.top);
    expect(top).toBeGreaterThanOrEqual(50 + 8);      // inside the field's top edge
    expect(top + 200).toBeLessThanOrEqual(650 - 8);  // bottom-aligned within the field (happy-dom ph fallback = 200)

    // Re-anchor on state render (result is taller than compose): still inside.
    [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Enhance").click();
    await tick();
    await tick();
    top = parseFloat(pop.style.top);
    expect(top).toBeGreaterThanOrEqual(50 + 8);
    expect(top + 200).toBeLessThanOrEqual(650 - 8);

    // Small field: popover cannot fit inside — below-the-field fallback.
    [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Accept").click();
    await tick();
    ta.getBoundingClientRect = () => ({ width: 120, height: 32, top: 0, left: 0, right: 120, bottom: 32, x: 0, y: 0 });
    ta.focus();
    await tick();
    root.querySelector(".zo-wa-icon").click();
    await tick();
    pop = root.querySelector(".zo-wa-pop");
    expect(parseFloat(pop.style.top)).toBe(32 + 8); // rect.bottom + 8
  });
});

describe("content.js — injection idempotency (#109)", () => {
  it("a second full script run into the same window binds nothing", async () => {
    const win2: any = new Window({ url: "https://example.test/article" });
    win2.document.write("<!DOCTYPE html><html><head><title>T</title></head><body><main><p>hi</p></main></body></html>");
    stubNonZeroRects(win2);
    const target1 = createTabTarget();
    setPageGlobals(win2, target1.chrome);
    await import("../../extension/content.js?file=content-flow-idem-1");
    const ctx = await target1.dispatch({ type: "CAPTURE_CONTEXT", tier: 0 });
    expect(String(ctx.url)).toContain("example.test");

    // Second run — same window, fresh script instance + fresh message target:
    // the guard flag must block every listener registration.
    const target2 = createTabTarget();
    loadContentScript(win2, target2.chrome);
    expect((win2 as any).__zoCobrowseContentLoaded).toBe(true);
    expect(target2.onMessage.listeners.size).toBe(0);
    // …while the first injection remains the live handler.
    const ctx2 = await target1.dispatch({ type: "CAPTURE_CONTEXT", tier: 0 });
    expect(String(ctx2.url)).toContain("example.test");
  });
});

describe("content.js — dead-page guard", () => {
  it("CAPTURE_CONTEXT on a chrome/about page degrades honestly instead of capturing", async () => {
    // content.js refuses to run meaningfully on dead pages (about:, chrome-extension:,
    // file:) — the same guard reinjection (#109) skips tabs for.
    const deadWin: any = new Window({ url: "about:blank" });
    deadWin.document.write("<!DOCTYPE html><html><head><title>Dead</title></head><body></body></html>");
    const deadTarget = createTabTarget();
    // Function-recipe (not a module import): a fresh script instance without
    // adding another instrumented module to this process's coverage set.
    loadContentScript(deadWin, deadTarget.chrome);
    const resp = await deadTarget.dispatch({ type: "CAPTURE_CONTEXT", tier: 2 });
    expect(resp).toEqual({ error: "Extension context unavailable" });
  });
});

describe("write-assist round 3 — streaming popover (#53)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // Local copies of the widget fixtures (makeWindow/shadow are scoped to the
  // round-1 describe above).
  function makeWindow() {
    const win: any = new Window({ url: "https://jobs.example.test/apply" });
    win.document.write(`<!DOCTYPE html><html><head><title>Job Application</title></head><body>
      <label for="proj">Describe your project</label>
      <textarea id="proj" name="proj" placeholder="Tell us about a project" maxlength="500">Led migration of 40 dashboards to DuckDB</textarea>
    </body></html>`);
    stubNonZeroRects(win);
    return win;
  }
  function shadow(win: any) {
    const host = win.document.getElementById("zo-write-assist-host");
    return host ? host.shadowRoot : null;
  }

  /** Widget chrome with a port factory: the test plays the background side
   *  of each cobrowse-wa-stream pair. */
  function makeStreamingWidgetChrome(opts: {
    enabled?: boolean;
    onPort?: (listener: any, caller: any) => void;
  } = {}) {
    const sent: any[] = [];
    const store: Record<string, any> = { enableWriteAssist: opts.enabled !== false };
    const ports: any[] = [];
    const chromeObj: any = {
      runtime: {
        onMessage: new FakeEvent(),
        sendMessage: (msg: any) => {
          sent.push(msg);
          return Promise.resolve({ ok: true, text: "IMPROVED RESULT" });
        },
        connect: (info?: any) => {
          const [caller, listener] = FakePort.pair(info?.name || "");
          ports.push(caller);
          if (opts.onPort) opts.onPort(listener, caller);
          return caller;
        },
        getURL: (p: string) => `chrome-extension://test/${p}`,
      },
      storage: {
        sync: {
          get: (keys: any, cb?: Function) => {
            const result: Record<string, any> = {};
            if (keys && typeof keys === "object" && !Array.isArray(keys)) {
              for (const [k, def] of Object.entries(keys)) result[k] = k in store ? store[k] : def;
            }
            if (cb) cb(result);
            return Promise.resolve(result);
          },
        },
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
    };
    return { chromeObj, sent, ports };
  }

  async function openPopoverForResult(win: any, chromeObj: any) {
    const ta = win.document.querySelector("#proj");
    ta.focus();
    await tick();
    const root = shadow(win);
    root.querySelector(".zo-wa-icon").click();
    await tick();
    const pop = root.querySelector(".zo-wa-pop");
    [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Enhance").click();
    await tick();
    return { pop, ta, root };
  }

  it("renders >=3 incremental deltas in the result view; narration never shows", async () => {
    // Step-driven delivery (deferredSse philosophy): the test pushes each
    // delta explicitly and samples the DOM between steps — no real timers.
    let driver: any = null;
    const { chromeObj } = makeStreamingWidgetChrome({
      onPort: (listener) => {
        listener.onMessage.addListener((m: any) => {
          if (m.type !== "WA_ENHANCE") return;
          driver = (msg: any) => listener.postMessage(msg);
        });
      },
    });
    const win = makeWindow();
    loadContentScript(win, chromeObj);
    await tick();
    const { pop } = await openPopoverForResult(win, chromeObj);
    await tick();
    expect(driver).toBeTruthy();

    const raws = [
      "Let me think about it. ",
      "Let me think about it. <write-assist>",
      "Let me think about it. <write-assist>First line. ",
      "Let me think about it. <write-assist>First line. Second line. ",
      "Let me think about it. <write-assist>First line. Second line. Third line.",
    ];
    const seenAt: string[] = [];
    for (const raw of raws) {
      driver({ type: "WA_DELTA", delta: raw, raw });
      await tick();
      const body = pop.querySelector(".zo-wa-result");
      if (body) seenAt.push(body.textContent);
    }
    // Narration (before the open tag) never renders, including in the
    // pre-tag states.
    for (const v of seenAt) expect(v.includes("Let me think")).toBe(false);
    // The three in-tag partials each rendered — >=3 incremental updates.
    const nonEmpty = new Set(seenAt.filter((v) => v.length > 0));
    expect(nonEmpty.size).toBe(3);

    driver({ type: "WA_DONE", text: "First line. Second line. Third line." });
    await tick();
    const body = pop.querySelector(".zo-wa-result");
    expect(body.textContent).toBe("First line. Second line. Third line.");
    expect([...pop.querySelectorAll("button")].some((b: any) => b.textContent === "Accept")).toBe(true);
    expect([...pop.querySelectorAll("button")].some((b: any) => b.textContent === "Shorter")).toBe(true);
  });

  it("the Shorter chip sends a threaded follow-up (conversationId + priorText) and Accept fills the field", async () => {
    const requests: any[] = [];
    let lastListener: any = null;
    const { chromeObj, sent } = makeStreamingWidgetChrome({
      onPort: (listener) => {
        lastListener = listener;
        listener.onMessage.addListener((m: any) => {
          if (m.type !== "WA_ENHANCE") return;
          requests.push(m);
          setTimeout(() => listener.postMessage({ type: "WA_DELTA", delta: "<write-assist>", raw: "<write-assist>" }), 2);
          setTimeout(() => listener.postMessage({
            type: "WA_DONE",
            text: m.priorText ? "SHORT VERSION" : "LONG FIRST PASS",
            conversationId: "conv_wa_42",
          }), 6);
        });
      },
    });
    const win = makeWindow();
    loadContentScript(win, chromeObj);
    await tick();
    const { pop, ta } = await openPopoverForResult(win, chromeObj);
    await new Promise((r) => setTimeout(r, 20));
    expect(requests[0].conversationId).toBeUndefined();
    expect(requests[0].priorText).toBeUndefined();

    // Click Shorter → the second request rides the thread + carries the prior.
    [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Shorter").click();
    await new Promise((r) => setTimeout(r, 20));
    expect(requests.length).toBe(2);
    expect(requests[1].conversationId).toBe("conv_wa_42");
    expect(requests[1].priorText).toBe("LONG FIRST PASS");
    expect(requests[1].instruction).toBe("make it shorter");
    await new Promise((r) => setTimeout(r, 10));

    // Accept fills the field via the unified pipeline; NO EXECUTE_ACTIONS ever
    // leaves this path (the #26 no-submit backstop cannot fire from here).
    [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Accept").click();
    await tick();
    expect(ta.value).toBe("SHORT VERSION");
    expect(sent.filter((m: any) => m.type === "EXECUTE_ACTIONS")).toHaveLength(0);
  });

  it("cancel mid-stream disconnects the port and closes cleanly", async () => {
    let driver: any = null;
    let disconnects = 0;
    const { chromeObj } = makeStreamingWidgetChrome({
      onPort: (listener) => {
        // The content side holds `caller`; its disconnect() fires the
        // LISTENER's onDisconnect (peer semantics).
        listener.onDisconnect.addListener(() => disconnects++);
        listener.onMessage.addListener((m: any) => {
          if (m.type !== "WA_ENHANCE") return;
          driver = (msg: any) => listener.postMessage(msg);
        });
      },
    });
    const win = makeWindow();
    loadContentScript(win, chromeObj);
    await tick();
    const { pop } = await openPopoverForResult(win, chromeObj);
    await tick();
    driver({ type: "WA_DELTA", delta: "<write-assist>partial", raw: "<write-assist>partial" });
    await tick();
    const body = pop.querySelector(".zo-wa-result");
    expect(body.textContent).toBe("partial");
    // Cancel (the streaming footer's button) → port teardown + reset.
    [...pop.querySelectorAll("button")].find((b: any) => b.textContent === "Cancel").click();
    await tick();
    expect(disconnects).toBe(1);
    // waClose hides the popover (the last render stays in the hidden host —
    // the next waShowCompose resets the view); the popover must not be visible.
    expect(pop.hidden).toBe(true);
  });

  it("an armed recorder emits a navigate observation on (re)arm (#268)", async () => {
    const sent: any[] = [];
    const chromeObj: any = {
      runtime: {
        onMessage: new FakeEvent(),
        sendMessage: (msg: any) => {
          if (msg?.type === "RECIPE_RECORD_PEEK") return Promise.resolve({ ok: true, armed: true });
          if (msg?.type === "RECIPE_OBS") { sent.push(msg.obs); return Promise.resolve({ ok: true }); }
          return Promise.resolve({ ok: true });
        },
        getURL: (p: string) => `chrome-extension://test/${p}`,
      },
      storage: {
        sync: { get: (_k: any, cb?: Function) => { const r = { enableWriteAssist: false }; if (cb) cb(r); return Promise.resolve(r); } },
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
    };
    const win: any = new Window({ url: "https://flow.example/step-2" });
    win.document.write("<!DOCTYPE html><html><head><title>S2</title></head><body><p>step two</p></body></html>");
    stubNonZeroRects(win);
    loadContentScript(win, chromeObj);
    await tick();
    await tick();
    const nav = sent.find((o) => o.op === "navigate");
    expect(nav).toBeTruthy();
    expect(nav.url).toBe("https://flow.example/step-2");
    expect(nav.cues).toEqual([]);
  });

  it("a runtime without connect falls back to the threadless one-shot (regression)", async () => {
    const { chromeObj, sent } = makeStreamingWidgetChrome(); // connect removed below
    delete chromeObj.runtime.connect; // older runtimes
    const win = makeWindow();
    loadContentScript(win, chromeObj);
    await tick();
    const { pop } = await openPopoverForResult(win, chromeObj);
    await tick();
    await tick();
    expect(sent.some((m: any) => m.type === "ENHANCE_TEXT")).toBe(true);
    expect(pop.querySelector(".zo-wa-result").textContent).toBe("IMPROVED RESULT");
  });
});
