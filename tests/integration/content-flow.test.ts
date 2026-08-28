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
import { createTabTarget, stubNonZeroRects } from "../helpers/chrome-mock.ts";

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
