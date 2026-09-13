import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "acorn";

const CONTENT_PATH = resolve(import.meta.dir, "../extension/content.js");
const code = readFileSync(CONTENT_PATH, "utf-8");

describe("content.js", () => {

  it("is valid JavaScript (no syntax errors)", () => {
    expect(() => parse(code, { ecmaVersion: "latest" })).not.toThrow();
  });

  it("captures page context via captureContext", () => {
    expect(code).toContain("captureContext");
    expect(code).toContain("doc.title");
    expect(code).toContain("location.href");
    expect(code).toContain("innerText");
  });

  it("executes browser actions (click, fill, extract, scroll)", () => {
    expect(code).toContain("case 'click'");
    expect(code).toContain("case 'fill'");
    expect(code).toContain("case 'extract'");
    expect(code).toContain("case 'scroll'");
  });

  it("responds to messages from background via chrome.runtime", () => {
    expect(code).toContain("chrome.runtime.onMessage.addListener");
    expect(code).toContain("'CAPTURE_CONTEXT'");
    expect(code).toContain("'EXECUTE_ACTION'");
  });

  it("provides a waitForElement helper", () => {
    expect(code).toContain("function waitForElement");
    expect(code).toContain("MutationObserver");
  });
});

/**
 * captureContext() contract — the structured page snapshot shipped to Zo.
 * These assertions pin the filtering + capping rules so a silent change to the
 * DOM-extraction logic can't shrink or corrupt the context without a failing
 * test. (content.js is an IIFE; this validates the contract statically the same
 * way remaining-coverage.test.ts does for background.js.)
 */
describe("content.js captureContext — extraction contract", () => {
  // Locate the captureContext function body (between its declaration and the
  // next top-level `function ` at column 2) so assertions target that scope.
  const start = code.indexOf("function captureContext(");
  const end = code.indexOf("\n  function ", start + 1);
  const fn = start !== -1 ? code.slice(start, end === -1 ? undefined : end) : code;

  it("returns url, title, visibleText, formFields, clickable, viewport, documentSize", () => {
    for (const key of ["url:", "title:", "visibleText", "formFields", "clickable", "viewport", "documentSize"]) {
      expect(fn).toContain(key);
    }
  });

  it("prefers <main>/<article>/[role=main] content, falling back to body", () => {
    // The selector cascade for the text source.
    expect(fn).toMatch(/main,\s*article/);
    expect(fn).toContain("[role=\"main\"]");
    expect(fn).toContain("doc.body");
  });

  it("slices visibleText to the maxTextLen budget (8000 default, 20000 pull:'page')", () => {
    expect(fn).toMatch(/maxTextLen\s*=\s*pull === 'page' \? 20000 : 8000/);
    expect(fn).toContain(".substring(0, maxTextLen)");
  });

  it("skips hidden inputs (type === 'hidden') from formFields", () => {
    expect(fn).toContain("'hidden'");
  });

  it("drops zero-size elements from formFields + clickable (size threshold)", () => {
    // formFields uses width===0 || height===0; clickable uses < 8px threshold.
    expect(fn).toContain("rect.width");
    expect(fn).toContain("rect.height");
  });

  it("caps formFields at 30 and clickable at 50 (raised for pull captures)", () => {
    expect(fn).toContain("pull === 'form' ? 300 : pull === 'dom' ? 150 : 30");
    expect(fn).toContain("pull === 'dom' ? 200 : 50");
  });

  it("captures a selector + placeholder + truncated value per form field", () => {
    expect(fn).toContain("buildSelector(el)");
    expect(fn).toContain("placeholder");
    expect(fn).toContain(".substring(0, 100)"); // value truncated to 100 chars
  });

  it("drops clickable elements with no visible text", () => {
    expect(fn).toMatch(/if\s*\(\s*!text\s*\)\s*return/);
  });

  it("truncates clickable label text to 60 chars", () => {
    expect(fn).toContain(".substring(0, 60)");
  });
});

/**
 * executeAction() contract — the per-action-type dispatch. Pin each case and
 * its return shape so a dropped/renamed branch is caught.
 */
describe("content.js executeAction — dispatch contract", () => {
  const start = code.indexOf("async function executeAction(");
  const end = code.indexOf("\n  const sleep", start + 1);
  const fn = start !== -1 ? code.slice(start, end === -1 ? undefined : end) : code;

  it("handles every action type in the protocol", () => {
    for (const t of ["'click'", "'fill'", "'extract'", "'scroll'", "'wait'", "'navigate'", "'done'"]) {
      expect(fn).toContain(`case ${t}`);
    }
  });

  it("returns ok:true for every recognized action", () => {
    // Each success branch carries ok: true.
    const okCount = (fn.match(/ok:\s*true/g) || []).length;
    expect(okCount).toBeGreaterThanOrEqual(7); // one per action type
  });

  it("unknown action types return ok:false with an error message", () => {
    expect(fn).toContain("default:");
    expect(fn).toContain("ok: false");
    expect(fn).toContain("Unknown action type");
  });

  it("done carries the response (terminal signal)", () => {
    expect(fn).toContain("action.response");
  });

  it("extract reads an attribute when provided, else textContent", () => {
    expect(fn).toContain("action.attribute");
    expect(fn).toContain("getAttribute");
    expect(fn).toContain("textContent");
  });

  it("scroll defaults to 70% of viewport height and honors direction up/down", () => {
    expect(fn).toContain("window.innerHeight * 0.7");
    expect(fn).toMatch(/direction\s*===\s*['"]up['"]/);
  });
});

/**
 * Message router contract — the chrome.runtime.onMessage listener that dispatch
 * CAPTURE_CONTEXT / EXECUTE_ACTION / unknown.
 */
describe("content.js message router — contract", () => {
  it("registers a single onMessage listener", () => {
    expect(code).toContain("chrome.runtime.onMessage.addListener");
  });

  it("handles CAPTURE_CONTEXT and EXECUTE_ACTION request types", () => {
    expect(code).toContain("'CAPTURE_CONTEXT'");
    expect(code).toContain("'EXECUTE_ACTION'");
  });

  it("EXECUTE_ACTION supports both a single action and an actions array", () => {
    expect(code).toContain("request.actions");
    expect(code).toContain("Array.isArray(request.actions)");
    expect(code).toContain("request.action");
  });

  it("responds cleanly to unknown request types (no port-closed rejection)", () => {
    expect(code).toContain("default:");
    expect(code).toContain("Unknown request type");
  });

  it("guards context capture against dead page protocols (about:/chrome-extension:/file:)", () => {
    expect(code).toContain("isAlive()");
    expect(code).toMatch(/about:|chrome-extension:|file:/);
    expect(code).toContain("Extension context unavailable");
  });
});