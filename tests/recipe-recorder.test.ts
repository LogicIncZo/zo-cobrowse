import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { runInSandbox } from "./helpers/vm-sandbox";
import { Window } from "happy-dom";

/**
 * Recipe recorder content half (#220) — runs the REAL rec* functions from
 * content.js (extracted verbatim) in happy-dom: cue snapshots carry
 * selector+question strategies, fills emit values on clean pages and NEVER
 * on sensitive fields, file inputs record attach, listeners only fire while
 * the session is armed.
 */

const SRC = readFileSync(resolve(import.meta.dir, "../extension/content.js"), "utf-8");

function extractFn(name: string): string {
  const asyncStart = SRC.indexOf("async function " + name + "(");
  let start = asyncStart !== -1 ? asyncStart : SRC.indexOf("function " + name + "(");
  if (start === -1) throw new Error("function not found: " + name);
  let depth = 0, began = false, i = start;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") { depth++; began = true; }
    else if (SRC[i] === "}") { depth--; if (began && depth === 0) break; }
  }
  return SRC.slice(start, i + 1);
}

// The recorder's regex + flag declarations, pulled verbatim so the extracted
// functions resolve them (mirrors the IIFE scope).
function extractDecl(prefix: string): string {
  const lines = SRC.split("\n").filter((l) => l.trim().startsWith(prefix));
  if (!lines.length) throw new Error("declaration not found: " + prefix);
  return lines.map((l) => l.trim()).join("\n");
}

const FN_NAMES = [
  "buildSelector",
  "nearestQuestion",
  "fieldSurface",
  "normCue",
  "resolveByQuestion",
  "pickVisible",
  "recCueSnapshot",
  "recObserve",
  "recArm",
  "recOnClick",
  "recOnChange",
] as const;

describe("content.js recipe recorder (#220)", () => {
  let win: Window;
  let doc: Document;
  let sends: any[];

  beforeAll(() => {
    win = new Window({ url: "https://fixture.example/form" });
    doc = win.document;
    doc.body.innerHTML = `
      <form>
        <label for="fullname">Applicant name</label>
        <input id="fullname" name="fullname" type="text">
        <input id="pw" name="pw" type="password" aria-label="Password">
        <input id="file" type="file">
        <button id="go" type="button">Submit Request</button>
      </form>
    `;
    sends = [];
    const sandbox: any = {
      document: doc,
      window: win,
      location: win.location,
      Event: win.Event,
      chrome: {
        runtime: {
          sendMessage: (msg: any) => { sends.push(msg); return Promise.resolve({ ok: true }); },
        },
      },
      Date,
      CSS: win.CSS || { escape: (s: string) => String(s).replace(/[^\w-]/g, "\\$&") },
    };
    sandbox.self = sandbox;
    const decls = [
      extractDecl("const REC_"),
      "let recArmed = false;",
    ].join("\n");
    const code =
      decls + "\n" +
      FN_NAMES.map((n) => extractFn(n)).join("\n") +
      "\nself.__capture = { fieldSurface, recCueSnapshot, recObserve, recArm, recOnClick, recOnChange };";
    runInSandbox(code, sandbox);
    (globalThis as any).__rec = sandbox.__capture;
  });

  const rec = () => (globalThis as any).__rec;

  function changeEvent(el: Element) {
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  it("cue snapshots carry a selector plus human strategies", () => {
    const cues = rec().recCueSnapshot(doc.querySelector("#fullname")!);
    expect(cues[0].strategy).toBe("selector");
    expect(cues[0].value).toContain("#fullname");
    expect(cues.some((c: any) => c.strategy === "question" && c.value.includes("Applicant name"))).toBe(true);
  });

  it("fills on clean pages emit the value; sensitive fields never do", () => {
    rec().recArm();
    changeEvent(doc.querySelector("#fullname")!);
    const fill = sends.find((s) => s.type === "RECIPE_OBS" && s.obs.op === "fill" && !s.obs.pageSensitive);
    expect(fill).toBeTruthy();
    expect(fill.obs.value).toBe("");
    // happy-dom sets nothing here — emit value comes from el.value ('' is fine);
    // the load-bearing assertion is the password event below.
    changeEvent(doc.querySelector("#pw")!);
    const pw = sends.find((s) => s.type === "RECIPE_OBS" && s.obs.op === "fill" && s.obs.fieldSensitive);
    expect(pw).toBeTruthy();
    expect(pw.obs.pageSensitive).toBe(true);
    expect("value" in pw.obs).toBe(false); // the value never leaves the page
  });

  it("file inputs record attach with the file name; submit-ish clicks are flagged", () => {
    changeEvent(doc.querySelector("#file")!);
    const att = sends.find((s) => s.type === "RECIPE_OBS" && s.obs.op === "attach");
    expect(att?.obs.fileName).toBe("attachment"); // no file chosen in happy-dom

    doc.querySelector("#go")!.dispatchEvent(new win.Event("click", { bubbles: true }));
    const click = sends.find((s) => s.type === "RECIPE_OBS" && s.obs.op === "click");
    expect(click?.obs.submitish).toBe(true);
  });

  it("sensitive surface parity: label/aria-labelledby/autocomplete context suppresses values (0.3.5 round-2)", () => {
    // Builder-style markup: neutral machine attrs, sensitive VISIBLE label —
    // the exact divergence the round-2 audit found (recOnChange used a
    // narrower surface than captureContext and emitted the typed value).
    doc.body.insertAdjacentHTML(
      "beforeend",
      `
      <form id="extra">
        <label for="q4">Credit card number</label>
        <input id="q4" name="field_7" type="text">
        <label for="q5">Delivery instructions</label>
        <input id="q5" name="field_8" type="text">
        <input id="q6" name="field_9" type="text" autocomplete="cc-csc">
        <input id="q7" name="field_10" type="text" placeholder="Security code">
        <input id="q8" name="field_11" type="text" aria-labelledby="q8lab">
        <span id="q8lab">Expiry year</span>
      </form>
    `,
    );
    // The shared helper surfaces the visible label context…
    const surface = rec().fieldSurface(doc.querySelector("#q4")!);
    expect(surface).toContain("Credit card number");
    // …and both suppression paths agree on it.
    const cases: Array<[string, boolean]> = [
      ["#q4", true], // label[for] says "Credit card number"
      ["#q5", false], // control — non-sensitive label keeps values flowing
      ["#q6", true], // autocomplete="cc-csc"
      ["#q7", true], // placeholder "Security code"
      ["#q8", true], // aria-labelledby "Expiry year"
    ];
    rec().recArm();
    for (const [sel, sensitive] of cases) {
      const before = sends.filter((s) => s.type === "RECIPE_OBS" && s.obs.op === "fill").length;
      changeEvent(doc.querySelector(sel)!);
      const fills = sends.filter((s) => s.type === "RECIPE_OBS" && s.obs.op === "fill");
      expect(fills.length).toBe(before + 1);
      const last = fills[fills.length - 1];
      if (sensitive) {
        expect(last.obs.fieldSensitive).toBe(true);
        expect("value" in last.obs).toBe(false);
      } else {
        expect("value" in last.obs).toBe(true);
      }
    }
  });

  it("listeners stay inert until armed", () => {
    const fresh = new Window({ url: "https://fixture.example/form" });
    fresh.document.body.innerHTML = `<input id="x" type="text">`;
    const localSends: any[] = [];
    const sandbox: any = {
      document: fresh.document,
      window: fresh,
      location: fresh.location,
      Event: fresh.Event,
      chrome: { runtime: { sendMessage: (msg: any) => { localSends.push(msg); return Promise.resolve({ ok: false }); } } },
      Date,
      CSS: fresh.CSS || { escape: (s: string) => String(s).replace(/[^\w-]/g, "\\$&") },
    };
    sandbox.self = sandbox;
    const decls = [extractDecl("const REC_"), "let recArmed = false;"].join("\n");
    const code = decls + "\n" + FN_NAMES.map((n) => extractFn(n)).join("\n") + "\nself.__cap2 = { recArm, recOnChange };";
    runInSandbox(code, sandbox);
    // NOT armed:
    fresh.document.querySelector("#x")!.dispatchEvent(new fresh.Event("change", { bubbles: true }));
    expect(localSends.filter((s) => s.type === "RECIPE_OBS")).toHaveLength(0);
    // Armed — arming itself records the page's navigation (#268), then the
    // change event flows through.
    sandbox.__cap2.recArm();
    fresh.document.querySelector("#x")!.dispatchEvent(new fresh.Event("change", { bubbles: true }));
    const obs = localSends.filter((s) => s.type === "RECIPE_OBS");
    expect(obs).toHaveLength(2);
    expect(obs[0].obs.op).toBe("navigate"); // #268: the arming page records its navigation
    expect(obs[1].obs.op).toBe("fill");
  });
});
