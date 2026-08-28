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
import { createTabTarget, stubNonZeroRects, FakeEvent } from "../helpers/chrome-mock.ts";

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

describe("content.js — full-script message flow", () => {
  let win: any;
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
