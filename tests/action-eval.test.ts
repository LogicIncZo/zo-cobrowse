import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { runInSandbox } from "./helpers/vm-sandbox";
import { Window } from "happy-dom";

/**
 * Hardening tests for background.js's two in-page action executors:
 *
 *   - makeActionEval — the CDP Runtime.evaluate fast path (executeActions
 *     Path 1). Its :has-text()/:text() fallback used to be DEAD CODE:
 *     document.querySelector(':has-text(…)') throws before the fallback could
 *     run, so the whole eval degraded to a raw "not a valid selector" error.
 *     A selector-less DOM action crashed on el.scrollIntoView with a TypeError.
 *
 *   - executeDomAction — the chrome.scripting.executeScript fallback (Path 3).
 *     Same shape: the querySelector at the top of the promise executor threw
 *     raw DOMExceptions for pseudo-selectors and empty selectors.
 *
 * Live corpus evidence (con_N4Lo0bXKrDhF3mnF, con_gpTuIzC7GBkVCNF6): Zo emits
 * Playwright-bare `text=…` selectors and occasionally selectors that resolve
 * to nothing — every failure below must be a clean, model-actionable error.
 */

const SRC = readFileSync(resolve(import.meta.dir, "../extension/background.js"), "utf-8");

// Extract a named function declaration by braces (same matcher form-fill uses).
function extractFn(name: string): string {
  const start = SRC.indexOf("function " + name + "(");
  if (start === -1) throw new Error("function not found: " + name);
  let depth = 0, began = false, i = start;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") { depth++; began = true; }
    else if (SRC[i] === "}") { depth--; if (began && depth === 0) break; }
  }
  return SRC.slice(start, i + 1);
}

const PAGE_HTML = `
  <a href="/request" id="sub">Submit Request</a>
  <button id="acc" type="submit">Create account</button>
  <label for="email">Email</label>
  <input type="email" id="email" name="email" />
`;

function makeSandbox(win: Window): Record<string, unknown> {
  const sandbox: any = {
    document: win.document,
    window: win,
    Event: win.Event,
    setTimeout,
    clearTimeout,
    innerHeight: 800,
    scrollBy: () => {},
    // happy-dom has no layout engine — scrollIntoView is a no-op stub.
  };
  (win.HTMLElement.prototype as any).scrollIntoView = () => {};
  sandbox.self = sandbox;
  return sandbox;
}

describe("background.js makeActionEval — fast-path selector hardening", () => {
  let win: Window;
  let makeActionEval: (action: any) => string;
  let run: (expr: string) => any;

  beforeAll(() => {
    win = new Window({ url: "https://example.test/" });
    win.document.body.innerHTML = PAGE_HTML;
    const sandbox: any = makeSandbox(win);
    runInSandbox(extractFn("makeActionEval") + "\nself.__mae = makeActionEval;", sandbox);
    makeActionEval = sandbox.__mae;
    run = (expr: string) => {
      sandbox.__out = undefined;
      runInSandbox(`self.__out = (${expr});`, sandbox);
      return sandbox.__out;
    };
  });

  it("builds an eval that clicks a CSS selector", () => {
    expect(run(makeActionEval({ type: "click", selector: "#acc" }))).toEqual({ ok: true, type: "click" });
  });

  it("the :has-text() fallback is reachable (querySelector throw no longer aborts the eval)", () => {
    const out = run(makeActionEval({ type: "click", selector: 'a:has-text("Submit Request")' }));
    expect(out).toEqual({ ok: true, type: "click" });
  });

  it("resolves Playwright bare text= selectors", () => {
    const out = run(makeActionEval({ type: "click", selector: "text=Submit Request" }));
    expect(out).toEqual({ ok: true, type: "click" });
  });

  it("a CSS miss reports Element not found (Path 2 then retries)", () => {
    const out = run(makeActionEval({ type: "click", selector: "#missing" }));
    expect(out.ok).toBe(false);
    expect(out.error).toBe("Element not found: #missing");
  });

  it("a selector-less click fails cleanly instead of TypeError on null", () => {
    const out = run(makeActionEval({ type: "click" }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no selector/);
    expect(out.error).not.toMatch(/Cannot read properties of null/);
  });

  it("a pseudo-selector fill reports a clean miss (Path 2 owns the field ladder)", () => {
    const out = run(makeActionEval({ type: "fill", selector: 'input:has-text("Email")', value: "x" }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Element not found/);
    expect(out.error).not.toMatch(/not a valid selector/);
  });
});

describe("background.js executeDomAction — executeScript-path selector hardening", () => {
  let win: Window;
  let executeDomAction: (action: any) => Promise<any>;

  beforeAll(() => {
    win = new Window({ url: "https://example.test/" });
    win.document.body.innerHTML = PAGE_HTML;
    const sandbox: any = makeSandbox(win);
    runInSandbox(extractFn("executeDomAction") + "\nself.__eda = executeDomAction;", sandbox);
    executeDomAction = sandbox.__eda;
  });

  it("fills a CSS-selected field", async () => {
    const res = await executeDomAction({ type: "fill", selector: "#email", value: "a@b.co" });
    expect(res).toEqual({ ok: true, type: "fill" });
    expect(win.document.querySelector("#email")!.value).toBe("a@b.co");
  });

  it("the :has-text() fallback is reachable for clicks", async () => {
    const res = await executeDomAction({ type: "click", selector: 'button:has-text("Create account")' });
    expect(res).toEqual({ ok: true, type: "click" });
  });

  it("resolves Playwright bare text= selectors for clicks", async () => {
    const res = await executeDomAction({ type: "click", selector: "text=Create account" });
    expect(res).toEqual({ ok: true, type: "click" });
  });

  it("a selector-less click rejects cleanly instead of TypeError on null", async () => {
    await expect(executeDomAction({ type: "click" })).rejects.toThrow(/no selector/);
  });

  it("a CSS miss rejects with Element not found", async () => {
    await expect(executeDomAction({ type: "click", selector: "#missing" })).rejects.toThrow(/Element not found: #missing/);
  });

  it("a pseudo-selector fill rejects cleanly (no raw DOMException)", async () => {
    await expect(executeDomAction({ type: "fill", selector: 'input:has-text("Email")', value: "x" }))
      .rejects.toThrow(/Element not found/);
    await expect(executeDomAction({ type: "fill", selector: 'input:has-text("Email")', value: "x" }))
      .rejects.not.toThrow(/not a valid selector/);
  });

  it("fill_form entries with pseudo-selectors resolve through the inlined field ladder", async () => {
    const res = await executeDomAction({
      type: "fill_form",
      values: [{ target: "Email", selector: 'input:has-text("Email")', value: "c@d.co" }],
    });
    expect(res.ok).toBe(true);
    expect(res.fields[0]).toMatchObject({ ok: true, target: "Email" });
    expect(win.document.querySelector("#email")!.value).toBe("c@d.co");
  });
});

describe("background.js probeClickTarget halves — #26 backstop must see cue-resolved targets", () => {
  // The sensitive-submit probe fails OPEN on a null result. Now that the
  // executors resolve :has-text()/text= cues, a probe stuck on bare
  // querySelector would fail open exactly on the clicks most worth stopping.
  let win: Window;
  let probeFn: (sel: string) => any;
  let probeExpr: (sel: string) => string;
  let sandbox: any;

  beforeAll(() => {
    win = new Window({ url: "https://example.test/" });
    win.document.body.innerHTML = `
      <form action="/pay">
        <input type="text" name="cc" />
        <button id="pay" type="submit">Pay Now</button>
      </form>
      <a href="/x" id="sub">Submit Request</a>
    `;
    sandbox = makeSandbox(win);
    runInSandbox(
      extractFn("probeFn") + "\n" + extractFn("probeExpr") + "\nself.__probe = { probeFn, probeExpr };",
      sandbox,
    );
    probeFn = sandbox.__probe.probeFn;
    probeExpr = sandbox.__probe.probeExpr;
  });

  it("probeFn resolves a CSS-selected submit button", () => {
    expect(probeFn("#pay")).toMatchObject({ form: true, tag: "button", type: "submit", text: "Pay Now" });
  });

  it("probeFn resolves bare text= cues (fail-open hole closed)", () => {
    expect(probeFn("text=Pay Now")).toMatchObject({ form: true, tag: "button", text: "Pay Now" });
  });

  it("probeFn resolves :has-text() cues", () => {
    expect(probeFn('a:has-text("Submit Request")')).toMatchObject({ form: false, tag: "a", text: "Submit Request" });
  });

  it("probeFn returns null for a miss and for a missing selector", () => {
    expect(probeFn("#missing")).toBeNull();
    expect(probeFn("")).toBeNull();
  });

  it("probeExpr serializes the same probeFn and agrees with it", () => {
    sandbox.__out = undefined;
    runInSandbox(`self.__out = (${probeExpr("text=Pay Now")});`, sandbox);
    expect(sandbox.__out).toEqual(probeFn("text=Pay Now"));
    sandbox.__out = undefined;
    runInSandbox(`self.__out = (${probeExpr("#missing")});`, sandbox);
    expect(sandbox.__out).toBeNull();
  });
});
