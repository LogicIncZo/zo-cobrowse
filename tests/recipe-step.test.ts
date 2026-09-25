import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { runInSandbox } from "./helpers/vm-sandbox";
import { Window } from "happy-dom";

/**
 * Recipe step executor (#220) — runs the REAL executeRecipeStep + cue
 * resolution functions from content.js (extracted verbatim) against a real
 * DOM (happy-dom), proving the deterministic player's in-page half:
 *   - cue arrays resolve in declared order (selector/text/label/aria/
 *     placeholder/question) with viewport preference via the field ladder
 *   - ops: fill (writeFieldValue pipeline), check, click, extract, waitFor
 *   - cue-miss returns a STRUCTURED miss ({cueMiss, tried, candidates}) that
 *     feeds the healer, never a thrown error
 *   - attach decodes base64 → File → DataTransfer → input.files
 */

const SRC = readFileSync(resolve(import.meta.dir, "../extension/content.js"), "utf-8");

// Same brace-matching extractor as tests/form-fill.test.ts.
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

const FN_NAMES = [
  "isValidCssSelector",
  "resolveClickableByText",
  "resolveClickTarget",
  "pickVisible",
  "normCue",
  "resolveByQuestion",
  "nearestQuestion",
  "buildSelector",
  "resolveFieldTarget",
  "fireValueEvents",
  "writeFieldValue",
  "setFieldValue",
  "waitForElement",
  "collectCueCandidates",
  "resolveRecipeCues",
  "applyRecipeOp",
  "executeRecipeStep",
  "executeAction",
] as const;

type Exe = (action: any) => Promise<any>;

function loadRunner(win: Window): { executeAction: Exe } {
  const sandbox: any = {
    document: win.document,
    window: win,
    Event: win.Event,
    MutationObserver: win.MutationObserver,
    DataTransfer: win.DataTransfer,
    File: win.File,
    setTimeout,
    clearTimeout,
    Date,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    Uint8Array,
    getComputedStyle: win.getComputedStyle.bind(win),
    CSS: win.CSS || { escape: (s: string) => String(s).replace(/[^\w-]/g, "\\$&") },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
  sandbox.self = sandbox;
  const prologue =
    "const sleep = (ms) => new Promise(r => setTimeout(r, ms));\n" +
    // #392: executeAction's scroll-into-view gate — same helper content.js defines.
    "const smoothBehavior = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';\n";
  const code =
    prologue +
    FN_NAMES.map((n) => extractFn(n)).join("\n") +
    "\nself.__capture = { executeAction };";
  runInSandbox(code, sandbox);
  return sandbox.__capture;
}

describe("content.js recipe_step — cue resolution + ops (#220)", () => {
  let win: Window;
  let executeAction: Exe;
  let doc: Document;

  beforeAll(() => {
    win = new Window({ url: "https://rti.example.gov.in/apply" });
    doc = win.document;
    doc.body.innerHTML = `
      <form id="apply-form">
        <h2>Applicant details</h2>
        <label for="fullname">Applicant name</label>
        <input id="fullname" name="fullname" type="text">
        <input id="bpl" name="bpl" type="checkbox"> BPL candidate
        <select id="state" name="state"><option value="">Pick</option><option value="mh">Maharashtra</option></select>
        <input id="aadhaar-copy" type="file">
        <button type="button" id="add-another">Add another address</button>
        <div id="reg-number">REG-2026-000123</div>
      </form>
    `;
    ({ executeAction } = loadRunner(win));
  });

  it("fill resolves by question cue and writes through the value pipeline", async () => {
    const r = await executeAction({
      type: "recipe_step",
      step: { type: "fill", cues: [{ strategy: "question", value: "Applicant name" }], value: "Ada Lovelace" },
    });
    expect(r.ok).toBe(true);
    expect(r.type).toBe("fill");
    expect((doc.querySelector("#fullname") as HTMLInputElement).value).toBe("Ada Lovelace");
  });

  it("cues are tried in declared order — a missing selector falls through to label", async () => {
    const r = await executeAction({
      type: "recipe_step",
      step: { type: "fill", cues: [{ strategy: "selector", value: "#does-not-exist" }, { strategy: "label", value: "Applicant name" }], value: "Grace Hopper" },
    });
    expect(r.ok).toBe(true);
    expect((doc.querySelector("#fullname") as HTMLInputElement).value).toBe("Grace Hopper");
    expect(r.tried).toEqual(["selector=#does-not-exist"]);
  });

  it("select fills pick the option by visible text", async () => {
    const r = await executeAction({
      type: "recipe_step",
      step: { type: "fill", cues: [{ strategy: "label", value: "state" }], value: "Maharashtra" },
    });
    expect(r.ok).toBe(true);
    expect((doc.querySelector("#state") as HTMLSelectElement).value).toBe("mh");
  });

  it("check toggles a checkbox and fires change", async () => {
    let changed = 0;
    doc.querySelector("#bpl")!.addEventListener("change", () => { changed++; });
    const r = await executeAction({
      type: "recipe_step",
      step: { type: "check", cues: [{ strategy: "selector", value: "#bpl" }] },
    });
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(true);
    expect((doc.querySelector("#bpl") as HTMLInputElement).checked).toBe(true);
    expect(changed).toBe(1);
  });

  it("click resolves by text cue", async () => {
    let clicked = 0;
    doc.querySelector("#add-another")!.addEventListener("click", () => { clicked++; });
    const r = await executeAction({
      type: "recipe_step",
      step: { type: "click", cues: [{ strategy: "text", value: "Add another address" }] },
    });
    expect(r.ok).toBe(true);
    expect(clicked).toBe(1);
  });

  it("extract returns text and attributes", async () => {
    const r = await executeAction({
      type: "recipe_step",
      step: { type: "extract", cues: [{ strategy: "selector", value: "#reg-number" }], evidenceKey: "registration", label: "Registration" },
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe("REG-2026-000123");
  });

  it("attach decodes base64 into the file input", async () => {
    const r = await executeAction({
      type: "recipe_step",
      step: { type: "attach", cues: [{ strategy: "selector", value: "#aadhaar-copy" }], path: "Documents/proof.pdf" },
      dataB64: Buffer.from("PDFBYTES").toString("base64"),
    });
    expect(r.ok).toBe(true);
    expect(r.file).toBe("proof.pdf");
    const files = (doc.querySelector("#aadhaar-copy") as any).files;
    expect(files.length).toBe(1);
    expect(files[0].name).toBe("proof.pdf");
    expect(files[0].size).toBe(8);
  });

  it("cue-miss returns a structured miss with tried + candidates (healer food)", async () => {
    const r = await executeAction({
      type: "recipe_step",
      step: { type: "fill", cues: [{ strategy: "selector", value: "#nope" }, { strategy: "question", value: "Nothing like this" }], value: "x" },
    });
    expect(r.ok).toBe(false);
    expect(r.cueMiss).toBe(true);
    expect(r.tried).toContain("selector=#nope");
    expect(Array.isArray(r.candidates)).toBe(true);
    expect(r.candidates.some((c: any) => (c.text || "").includes("Add another address"))).toBe(true);
  });

  it("waitFor resolves once the element exists, and reports a miss on timeout", async () => {
    const ok = await executeAction({
      type: "recipe_step",
      step: { type: "waitFor", cue: { strategy: "selector", value: "#reg-number" }, timeoutMs: 1000 },
    });
    expect(ok.ok).toBe(true);

    const miss = await executeAction({
      type: "recipe_step",
      step: { type: "waitFor", cue: { strategy: "selector", value: "#ghost" }, timeoutMs: 300 },
    });
    expect(miss.ok).toBe(false);
    expect(miss.cueMiss).toBe(true);
  });
});
