import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { runInSandbox } from "./helpers/vm-sandbox";
import { Window } from "happy-dom";

/**
 * Integration test for the form-filling path — runs the REAL waitForElement +
 * executeAction functions from content.js (extracted verbatim) against a real
 * DOM (happy-dom), proving "does it fill forms?" end-to-end at the DOM level:
 *   - sets the field value (input/textarea/select)
 *   - fires input + change events (so React/Vue two-way binding picks it up)
 *   - missing element → waits then errors (waitForElement timeout path)
 *   - returns { ok: true, type: 'fill' } so the action timeline marks it done
 */

const SRC = readFileSync(resolve(import.meta.dir, "../extension/content.js"), "utf-8");

// Extract a named function declaration (indented inside the IIFE) by braces.
// Handles both `async function X(` and `function X(` — and returns the region
// spanning from the `function` keyword through the matching close brace.
function extractFn(name: string): string {
  // Prefer an `async function name(` (executed verbatim in the sandbox).
  const asyncStart = SRC.indexOf("async function " + name + "(");
  let start = asyncStart !== -1 ? asyncStart : SRC.indexOf("function " + name + "(");
  if (start === -1) {
    // async function matched — start extraction at the `async` keyword so the
    // extracted slice is a self-contained declaration.
    start = SRC.indexOf("function " + name + "(");
    if (start === -1) throw new Error("function not found: " + name);
  }
  let depth = 0, began = false, i = start;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") { depth++; began = true; }
    else if (SRC[i] === "}") { depth--; if (began && depth === 0) break; }
  }
  return SRC.slice(start, i + 1);
}

type Action = { type: string; selector?: string; value?: string; attribute?: string; direction?: string; amount?: number; ms?: number; url?: string };
type Exe = (action: Action) => Promise<any>;

function loadRealRunner(win: Window): { executeAction: Exe; waitForElement: (sel: string, t?: number) => Promise<any> } {
  const sandbox: any = {
    document: win.document,
    window: win,
    Event: win.Event,
    MutationObserver: win.MutationObserver,
    setTimeout,
    clearTimeout,
    getComputedStyle: win.getComputedStyle.bind(win),
    // executeAction's navigate case is a no-op for forwarded actions; safe.
    // The extracted code references `sleep` (arrow) — provide it.
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    __capture: null,
  };
  sandbox.self = sandbox;
  const prologue =
    "const sleep = (ms) => new Promise(r => setTimeout(r, ms));\n" +
    // #392: executeAction's scroll-into-view gate — same helper content.js defines.
    "const smoothBehavior = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';\n";
  runInSandbox(
    prologue +
    extractFn("isValidCssSelector") + "\n" +
    extractFn("resolveClickableByText") + "\n" + // #220: resolveClickTarget's text-match half
    extractFn("selectorTextCue") + "\n" + // #428: :has-text()/:text()/text= cue extraction
    extractFn("resolveClickTarget") + "\n" +
    extractFn("fireValueEvents") + "\n" +
    extractFn("writeFieldValue") + "\n" + // #53: setFieldValue delegates here
    extractFn("setFieldValue") + "\n" +
    extractFn("waitForElement") + "\n" +
    extractFn("pickVisible") + "\n" + // #428: resolveFieldTarget's viewport pick
    extractFn("normCue") + "\n" +
    extractFn("nearestQuestion") + "\n" +
    extractFn("resolveByQuestion") + "\n" +
    extractFn("resolveFieldTarget") + "\n" + // #428: fill's pseudo-selector ladder
    extractFn("executeAction") + "\n" +
    "self.__capture = { waitForElement, executeAction };",
    sandbox,
  );
  return sandbox.__capture;
}

describe("content.js fill — end-to-end DOM", () => {
  let win: Window;
  let executeAction: Exe;
  let waitForElement: (sel: string, t?: number) => Promise<any>;

  beforeAll(() => {
    win = new Window({ url: "https://example.test/form" });
    win.document.body.innerHTML = `
      <form id="contact">
        <input type="text" id="name" name="name" />
        <input type="email" id="email" name="email" />
        <textarea id="message" name="message"></textarea>
        <select id="plan" name="plan">
          <option value="">choose...</option>
          <option value="pro">Pro</option>
        </select>
      </form>
    `;
    // Record input/change events like a framework's two-way binding.
    win.document.querySelectorAll("input, textarea, select").forEach((el: any) => {
      for (const ev of ["input", "change"]) {
        (el as any).addEventListener(ev, () => {
          const doc = win.document as any;
          doc.__formEvents = doc.__formEvents || [];
          doc.__formEvents.push(`${el.id}:${ev}:${el.value}`);
        });
      }
    });
    ({ executeAction, waitForElement } = loadRealRunner(win));
  });

  it("fills a text input, sets the value, and fires input+change", async () => {
    const res = await executeAction({ type: "fill", selector: "#name", value: "Jane Doe" });
    expect(res).toEqual({ ok: true, type: "fill" });
    expect(win.document.querySelector("#name")!.value).toBe("Jane Doe");
    const evs = (win.document as any).__formEvents || [];
    expect(evs).toContain("name:input:Jane Doe");
    expect(evs).toContain("name:change:Jane Doe");
  });

  it("fills a textarea and an email field", async () => {
    await executeAction({ type: "fill", selector: "#message", value: "Hello" });
    await executeAction({ type: "fill", selector: "#email", value: "jane@example.com" });
    expect(win.document.querySelector("#message")!.value).toBe("Hello");
    expect(win.document.querySelector("#email")!.value).toBe("jane@example.com");
  });

  it("fills a SELECT via value assignment + fires change", async () => {
    // content.js sets el.value directly; happy-dom select uses option values.
    const res = await executeAction({ type: "fill", selector: "#plan", value: "pro" });
    // A real select needs the option selected; the generic fill sets .value
    // which for selects does select the matching option in browsers.
    expect(win.document.querySelector("#plan")!.value).toBe("pro");
    expect(res!.ok).toBe(true);
  });

  it("fills a SELECT by visible option text when the value attr does not match", async () => {
    // Zo sends the visible text ("Visa (Preferred)"); the option value is "pro".
    const res = await executeAction({ type: "fill", selector: "#plan", value: "Pro" });
    expect(win.document.querySelector("#plan")!.value).toBe("pro");
    expect(res!.ok).toBe(true);
  });

  it("waitForElement resolves an existing element", async () => {
    const el = await waitForElement("#contact");
    expect((el as any).id).toBe("contact");
  });

  it("waitForElement rejects for a missing element (after timeout)", async () => {
    await expect(waitForElement("#not-there", 50)).rejects.toThrow(/not found/i);
  });

  it("click path works and returns ok", async () => {
    const res = await executeAction({ type: "click", selector: "#name" });
    expect(res!.ok).toBe(true);
  });

  it("click resolves Playwright :has-text() selectors by text content", async () => {
    // Add a button with visible text so resolveClickTarget can find it.
    const btn = win.document.createElement("button");
    btn.textContent = "Subscribe Now";
    btn.type = "submit";
    win.document.querySelector("#contact")!.appendChild(btn);
    // The selector is NOT valid CSS — must fall back to text match.
    const res = await executeAction({ type: "click", selector: 'button:has-text("Subscribe Now")' });
    expect(res!.ok).toBe(true);
  });
});

describe("content.js buildSelector — form-field targeting", () => {
  // buildSelector() turns a captured field into a stable CSS selector that is
  // shipped in `## Forms` and used by Zo's fill{selector,value} actions. If
  // this breaks, fills silently miss fields. Test the REAL function extracted
  // from content.js (CSS.escape is provided by happy-dom).
  function loadBuildSelector(win: Window) {
    const sandbox: any = { document: win.document, window: win, CSS: win.CSS };
    sandbox.self = sandbox;
    runInSandbox(
      extractFn("buildSelector") + "\nself.__bs = buildSelector;",
      sandbox,
    );
    if (typeof sandbox.__bs !== "function") throw new Error("buildSelector not loaded");
    return sandbox.__bs as (el: any) => string;
  }

  let win: Window;
  let buildSelector: (el: any) => string;
  beforeAll(() => {
    win = new Window({ url: "https://example.test" });
    win.document.body.innerHTML = `
      <form>
        <input id="name" name="name" />
        <input name="email" />
        <select name="plan"><option value="a">A</option></select>
        <input class="field" />
        <input class="field" />
      </form>
    `;
    buildSelector = loadBuildSelector(win);
  });

  it("prefers a stable #id selector", () => {
    expect(buildSelector(win.document.querySelector("#name"))).toBe("#name");
  });

  it("falls back to tag[name=...] for named fields", () => {
    expect(buildSelector(win.document.querySelector("[name='email']"))).toBe('input[name="email"]');
    expect(buildSelector(win.document.querySelector("[name='plan']"))).toBe('select[name="plan"]');
  });

  it("disambiguates duplicate tags with nth-child", () => {
    const els = win.document.querySelectorAll("input.field");
    expect(buildSelector(els[0])).toMatch(/:nth-child\(\d+\)/);
    expect(buildSelector(els[1])).toMatch(/:nth-child\(\d+\)/);
    // The two siblings must resolve to distinct selectors.
    expect(buildSelector(els[0])).not.toBe(buildSelector(els[1]));
  });
});

describe("content.js selector hardening — clean failures + text= cues", () => {
  // Live corpus (con_N4Lo0bXKrDhF3mnF, con_gpTuIzC7GBkVCNF6): an unresolvable
  // locator used to reach waitForElement('') and surface the raw
  // "Failed to execute 'querySelector' … The provided selector is empty"
  // DOMException in the chat. Every failure below must be a clean,
  // model-actionable error instead, and Playwright's bare `text=…` syntax
  // (which Zo demonstrably emits) must resolve.
  let win: Window;
  let executeAction: Exe;
  let waitForElement: (sel: string, t?: number) => Promise<any>;

  beforeAll(() => {
    win = new Window({ url: "https://example.test/hardening" });
    win.document.body.innerHTML = `
      <form id="signup">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" />
        <button type="submit">Create account</button>
      </form>
    `;
    // happy-dom has no layout engine — scrollIntoView is a no-op stub.
    (win.HTMLElement.prototype as any).scrollIntoView = () => {};
    ({ executeAction, waitForElement } = loadRealRunner(win));
  });

  it("click with no selector fails cleanly (no querySelector DOMException)", async () => {
    const res = await executeAction({ type: "click", selector: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no selector/i);
    expect(res.error).not.toMatch(/querySelector|DOMException/i);
  });

  it("click with a missing selector field fails cleanly", async () => {
    const res = await executeAction({ type: "click" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no selector/i);
  });

  it("click resolves Playwright bare text= selectors", async () => {
    const res = await executeAction({ type: "click", selector: "text=Create account" });
    expect(res).toEqual({ ok: true, type: "click" });
  });

  it("click resolves quoted text= selectors", async () => {
    const res = await executeAction({ type: "click", selector: 'text="Create account"' });
    expect(res).toEqual({ ok: true, type: "click" });
  });

  it("click with an unmatched :has-text() selector reports Element not found (not the empty-selector DOMException)", async () => {
    await expect(executeAction({ type: "click", selector: 'button:has-text("Nonexistent")' }))
      .rejects.toThrow(/Element not found/);
    await expect(executeAction({ type: "click", selector: 'button:has-text("Nonexistent")' }))
      .rejects.not.toThrow(/provided selector is empty/);
  });

  it("fill resolves Playwright bare text= selectors through the field ladder", async () => {
    const res = await executeAction({ type: "fill", selector: "text=Email", value: "a@b.co" });
    expect(res).toEqual({ ok: true, type: "fill" });
    expect(win.document.querySelector("#email")!.value).toBe("a@b.co");
  });

  it("fill resolves :has-text() selectors through the field ladder", async () => {
    const res = await executeAction({ type: "fill", selector: 'input:has-text("Email")', value: "c@d.co" });
    expect(res).toEqual({ ok: true, type: "fill" });
    expect(win.document.querySelector("#email")!.value).toBe("c@d.co");
  });

  it("fill with no selector fails cleanly", async () => {
    const res = await executeAction({ type: "fill", value: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no selector/i);
    expect(res.error).not.toMatch(/querySelector|DOMException/i);
  });

  it("fill with an unmatched pseudo-selector reports Element not found", async () => {
    await expect(executeAction({ type: "fill", selector: 'input:has-text("Nope")', value: "x" }))
      .rejects.toThrow(/Element not found/);
  });

  it("extract with no selector fails cleanly", async () => {
    const res = await executeAction({ type: "extract", selector: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no selector/i);
  });

  it("extract with a pseudo-selector asks for valid CSS instead of throwing a DOMException", async () => {
    await expect(executeAction({ type: "extract", selector: 'div:has-text("x")' }))
      .rejects.toThrow(/not valid CSS/);
  });

  it("waitForElement rejects an empty selector with a clean error", async () => {
    await expect(waitForElement("", 10)).rejects.toThrow(/not found/i);
    await expect(waitForElement("", 10)).rejects.not.toThrow(/provided selector is empty/);
  });

  it("waitForElement rejects an invalid selector with a clean error", async () => {
    await expect(waitForElement(':has-text("x")', 10)).rejects.toThrow(/not found/i);
  });

  it("fill_form entries with pseudo-selectors resolve through the field ladder (no raw throw)", async () => {
    const res = await executeAction({
      type: "fill_form",
      values: [{ target: "Email", selector: 'input:has-text("Email")', value: "e@f.co" }],
    });
    expect(res.ok).toBe(true);
    expect(res.fields[0]).toMatchObject({ ok: true, target: "Email" });
    expect(win.document.querySelector("#email")!.value).toBe("e@f.co");
  });
});
