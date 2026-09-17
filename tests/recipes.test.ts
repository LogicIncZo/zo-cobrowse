import { describe, it, expect } from "bun:test";
import {
  validateRecipe,
  substituteParams,
  bumpVersion,
  recipeProgress,
  MAX_WAIT_MS,
} from "../extension/lib/recipes.js";
import {
  Recipe,
  RecipeValidation,
  type Recipe,
} from "./schemas/recipes.js";

// ---- Fixtures -------------------------------------------------------------

const T0 = 1757800000000;

function cue(strategy: string, value: string) {
  return { strategy, value };
}

// Minimal valid recipe — every field the schema demands, nothing more.
function validRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "rcp-test",
    name: "Test flow",
    version: "1.0.0",
    origin: "recipes/test.json",
    createdAt: T0,
    updatedAt: T0,
    params: [{ name: "applicant", type: "string", required: true, question: "Who is applying?" }],
    steps: [
      { type: "navigate", url: "https://example.gov.in/guidelines", expectUrl: "guidelines" },
      { type: "check", cues: [cue("label", "I undertake"), cue("selector", "#undertake")] },
      { type: "human", title: "Verify captcha + OTP", instructions: "Enter the captcha and the OTP from your email, then continue.", resumeOn: { url: "request-form" } },
      { type: "fill", cues: [cue("question", "Applicant name"), cue("selector", "#fullname")], value: "{{applicant}}" },
      { type: "extract", cues: [cue("question", "Registration number"), cue("selector", "#reg-num")], evidenceKey: "registration", label: "Registration number" },
      { type: "done", message: "Filed: {{registration}}" },
    ],
    ...overrides,
  } as Recipe;
}

// ---- Schema conformance ---------------------------------------------------

describe("Recipe schema conformance", () => {
  it("a minimal valid recipe parses against the Zod contract", () => {
    const r = validRecipe();
    const parsed = Recipe.safeParse(r);
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.success).toBe(true);
  });
});

// ---- validateRecipe -------------------------------------------------------

describe("validateRecipe", () => {
  it("accepts a valid recipe with empty errors and warnings", () => {
    const v = validateRecipe(validRecipe());
    const shape = RecipeValidation.safeParse(v);
    if (!shape.success) throw new Error(shape.error.message);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it("E-INVARIANT: rejects a submitish click with no preceding human step (#220 guarantee)", () => {
    const r = validRecipe();
    // Base steps: [navigate, check, human, fill, …] — insert after the check,
    // so the submitish click does NOT follow the human step.
    (r.steps as any[]).splice(2, 0, { type: "click", cues: [cue("text", "Submit Request")], submitish: true });
    const v = validateRecipe(r);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("submitish") && e.includes("human"))).toBe(true);
  });

  it("E-INVARIANT: rejects a submitish click as the very first step", () => {
    const r = validRecipe();
    (r.steps as any[]).unshift({ type: "click", cues: [cue("text", "Pay Now")], submitish: true });
    const v = validateRecipe(r);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("submitish"))).toBe(true);
  });

  it("E-INVARIANT: accepts a submitish click immediately after a human step", () => {
    const r = validRecipe();
    // Insert directly after the human step (index 2) — this is the one legal
    // position for a submitish click.
    (r.steps as any[]).splice(3, 0, { type: "click", cues: [cue("text", "Proceed to Pay")], submitish: true });
    const v = validateRecipe(r);
    expect(v.ok).toBe(true);
  });

  it("E-INVARIANT: a non-submitish click needs no human step", () => {
    const r = validRecipe();
    (r.steps as any[]).splice(3, 0, { type: "click", cues: [cue("text", "Add another attachment")] });
    const v = validateRecipe(r);
    expect(v.ok).toBe(true);
  });

  it("rejects unknown step types and empty steps", () => {
    expect(validateRecipe({ ...validRecipe(), steps: [] }).ok).toBe(false);
    const r = validRecipe();
    (r.steps as any[])[0] = { type: "hover", url: "https://x" };
    const v = validateRecipe(r);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("Unknown step type"))).toBe(true);
  });

  it("rejects interactive steps with empty cue arrays", () => {
    const r = validRecipe();
    (r.steps as any[])[3].cues = [];
    const v = validateRecipe(r);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("cue"))).toBe(true);
  });

  it("rejects a human step without a resumeOn postcondition", () => {
    const r = validRecipe();
    (r.steps as any[])[2].resumeOn = {};
    const v = validateRecipe(r);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("resumeOn"))).toBe(true);
  });

  it("rejects waitFor over the cap and with no condition", () => {
    const r = validRecipe();
    (r.steps as any[]).splice(4, 0, { type: "waitFor", timeoutMs: MAX_WAIT_MS + 1, cue: cue("selector", "#x") });
    (r.steps as any[]).splice(5, 0, { type: "waitFor" });
    const v = validateRecipe(r);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("waitFor"))).toBe(true);
  });

  it("rejects unknown {{param}} references", () => {
    const r = validRecipe();
    (r.steps as any[])[5].message = "Filed: {{regnum}}";
    const v = validateRecipe(r);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("Unknown parameter") && e.includes("regnum"))).toBe(true);
  });

  it("rejects duplicate and malformed params", () => {
    const r = validRecipe({
      params: [
        { name: "applicant", type: "string", required: true, question: "Who is applying?" },
        { name: "applicant", type: "url", required: false, question: "" },
      ],
    });
    expect(validateRecipe(r).ok).toBe(false);
    const bad = validRecipe({
      params: [{ name: "applicant", type: "blob" as any, required: true, question: "q" }],
    });
    expect(validateRecipe(bad).ok).toBe(false);
  });

  it("warns on selector-only cue arrays and expectUrl-less navigates", () => {
    const r = validRecipe();
    (r.steps as any[])[3].cues = [cue("selector", "#fullname")];
    (r.steps as any[])[0] = { type: "navigate", url: "https://example.gov.in/guidelines" };
    const v = validateRecipe(r);
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes("brittle"))).toBe(true);
    expect(v.warnings.some((w) => w.includes("expectUrl"))).toBe(true);
  });
});

// ---- substituteParams -----------------------------------------------------

describe("substituteParams", () => {
  const params = [
    { name: "applicant", type: "string" as const, required: true, question: "Who is applying?" },
    { name: "mode", type: "string" as const, required: false, question: "Mode", default: "Normal" },
  ];

  it("substitutes {{name}} across step string fields", () => {
    const r = validRecipe({ params });
    (r.steps as any[])[0].url = "https://example.gov.in/{{applicant}}/form";
    const res = substituteParams(r, { applicant: "Ada Lovelace" });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    const fillStep: any = res.recipe.steps[3];
    expect(fillStep.value).toBe("Ada Lovelace");
    expect((res.recipe.steps[0] as any).url).toContain("Ada Lovelace");
  });

  it("uses param defaults when the value is absent", () => {
    const r = validRecipe({ params });
    (r.steps as any[])[3].value = "mode={{mode}}";
    const res = substituteParams(r, { applicant: "Ada" });
    expect(res.ok).toBe(true);
    expect((res.recipe.steps[3] as any).value).toBe("mode=Normal");
  });

  it("errors on missing required params and unknown value keys", () => {
    const r = validRecipe({ params });
    const missing = substituteParams(r, {});
    expect(missing.ok).toBe(false);
    expect(missing.errors.some((e) => e.includes("applicant"))).toBe(true);

    const unknown = substituteParams(r, { applicant: "Ada", nmae: "typo" });
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.some((e) => e.includes("nmae"))).toBe(true);
  });

  it("leaves {{evidenceKey}} refs intact — they resolve at run time, not start", () => {
    const r = validRecipe();
    const res = substituteParams(r, { applicant: "Ada" });
    expect(res.ok).toBe(true);
    expect((res.recipe.steps[5] as any).message).toBe("Filed: {{registration}}");
  });

  it("does not mutate the input recipe", () => {
    const r = validRecipe({ params });
    const before = JSON.stringify(r);
    substituteParams(r, { applicant: "Ada" });
    expect(JSON.stringify(r)).toBe(before);
  });
});

// ---- bumpVersion ----------------------------------------------------------

describe("bumpVersion", () => {
  it("bumps patch / minor / major", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
    expect(bumpVersion("1.2.3")).toBe("1.2.4");
  });
  it("returns null on malformed versions", () => {
    expect(bumpVersion("1.2", "patch")).toBe(null);
    expect(bumpVersion("", "patch")).toBe(null);
  });
});

// ---- recipeProgress -------------------------------------------------------

describe("recipeProgress", () => {
  it("renders a running line with step, evidence and elapsed", () => {
    const line = recipeProgress(
      { status: "running", stepIndex: 1, stepsTotal: 5, evidence: [{ key: "k", label: "l", value: "v", ts: T0 }], startedAt: T0 },
      T0 + 200_000, // 3m20s
    );
    expect(line).toBe("running · step 2/5 · 1 evidence · 3m");
  });

  it("renders a waiting_human line with the checkpoint title", () => {
    const line = recipeProgress(
      { status: "waiting_human", stepIndex: 2, stepsTotal: 5, evidence: [], startedAt: T0, humanTitle: "Pay ₹10" },
      T0 + 250_000,
    );
    expect(line).toBe("waiting for you — Pay ₹10 · step 3/5 · 0 evidence · 4m");
  });

  it("renders terminal statuses without step detail", () => {
    expect(recipeProgress({ status: "done", stepIndex: 6, stepsTotal: 6, evidence: [], startedAt: T0 }, T0 + 60_000)).toBe("done · 0 evidence · 1m");
    expect(recipeProgress({ status: "blocked", stepIndex: 3, stepsTotal: 6, evidence: [], startedAt: T0, stopReason: "cue miss" }, T0 + 60_000)).toBe("blocked — cue miss · 0 evidence · 1m");
  });
});

// ---- healer pure halves (PR3) ---------------------------------------------

import { healPrompt, parseRecipeHealResponse } from "../extension/lib/recipes.js";

describe("healPrompt / parseRecipeHealResponse", () => {
  const step = { type: "fill", cues: [{ strategy: "question", value: "Ghost" }], value: "x" };
  const miss = { tried: ["question=Ghost"], candidates: [{ text: "Your name", selector: "#fullname" }] };

  it("healPrompt carries the failed cues, candidates and a JSON-only reply protocol", () => {
    const p = healPrompt({ name: "RTI" }, step, miss, { url: "https://x/form", title: "Form", formFields: [{ tag: "input", type: "text", question: "Your name", selector: "#fullname" }] });
    expect(p).toContain("## Recipe Step Repair");
    expect(p).toContain("question=Ghost");
    expect(p).toContain("Your name");
    expect(p).toContain('"cues"');
    expect(p).toContain("never a single selector");
  });

  it("healPrompt redacts all live field values (they never leave the extension)", () => {
    const p = healPrompt({ name: "R" }, step, miss, {
      url: "https://x", title: "T",
      formFields: [{ tag: "input", type: "password", name: "pw", value: "hunter2", selector: "#pw" }],
    });
    expect(p).not.toContain("hunter2");
  });

  it("parseRecipeHealResponse accepts fenced JSON with valid cues", () => {
    const res = parseRecipeHealResponse('```json\n{"cues":[{"strategy":"selector","value":"#fullname"},{"strategy":"question","value":"Your name"}],"note":"renamed"}\n```');
    expect(res.ok).toBe(true);
    expect(res.cues).toHaveLength(2);
    expect(res.note).toBe("renamed");
  });

  it("parseRecipeHealResponse rejects invalid JSON, bad cues, and single-selector answers", () => {
    expect(parseRecipeHealResponse("no json here").ok).toBe(false);
    expect(parseRecipeHealResponse(JSON.stringify({ cues: [{ strategy: "psychic", value: "x" }] })).ok).toBe(false);
    expect(parseRecipeHealResponse(JSON.stringify({ cues: [{ strategy: "selector", value: "#a" }] })).ok).toBe(false);
    expect(parseRecipeHealResponse(JSON.stringify({ cues: [] })).ok).toBe(false);
  });
});

// ---- recorder pure halves (PR4) --------------------------------------------

import { assembleDraftRecipe, generateRecipePrompt, parseGeneratedRecipe } from "../extension/lib/recipes.js";

describe("assembleDraftRecipe", () => {
  const T = 1757800000000;
  const nav = (url, title, ts, pageSensitive = false) => ({ op: "navigate", url, title, ts, pageSensitive });
  const fill = (url, cues, value, ts, pageSensitive = false) => ({ op: "fill", url, title: "T", cues, value, ts, pageSensitive });

  it("assembles navigations + fills into a valid draft recipe; values become param defaults", () => {
    const res = assembleDraftRecipe([
      nav("https://x.test/form", "Form", T),
      fill("https://x.test/form", [{ strategy: "question", value: "Applicant name" }], "Ada Lovelace", T + 1),
    ], "my flow", T);
    expect(res.ok).toBe(true);
    const v = validateRecipe(res.recipe);
    expect(v.errors).toEqual([]);
    expect(res.recipe.draft).toBe(true);
    expect(res.recipe.params).toHaveLength(1);
    expect(res.recipe.params[0].default).toBe("Ada Lovelace");
    const fillStep = res.recipe.steps.find((s) => s.type === "fill");
    expect(fillStep.value).toBe("{{applicant_name}}");
  });

  it("collapses sensitive-page events into ONE human step whose resumeOn is the next clean page", () => {
    const res = assembleDraftRecipe([
      nav("https://x.test/form", "Form", T),
      fill("https://x.test/checkout", [{ strategy: "selector", value: "#cc" }], "411111", T + 1, true),
      nav("https://x.test/receipt", "Receipt", T + 2),
    ], "pay flow", T);
    expect(res.ok).toBe(true);
    const humans = res.recipe.steps.filter((s) => s.type === "human");
    expect(humans).toHaveLength(1);
    expect(humans[0].resumeOn.url).toContain("receipt");
    // The sensitive value must not survive anywhere in the draft.
    expect(JSON.stringify(res.recipe)).not.toContain("411111");
    const v = validateRecipe(res.recipe);
    expect(v.ok).toBe(true);
  });

  it("a submitish click on a clean page gets a human step inserted before it", () => {
    const res = assembleDraftRecipe([
      nav("https://x.test/request", "Request", T),
      { op: "click", url: "https://x.test/request", title: "T", cues: [{ strategy: "text", value: "Submit Request" }], submitish: true, pageSensitive: false, ts: T + 1 },
      nav("https://x.test/done", "Done", T + 2),
    ], "submit flow", T);
    expect(res.ok).toBe(true);
    const steps = res.recipe.steps;
    const submitIdx = steps.findIndex((s) => s.type === "click" && s.submitish);
    expect(steps[submitIdx - 1].type).toBe("human"); // the invariant, authored
    expect(validateRecipe(res.recipe).ok).toBe(true);
  });

  it("an attach event parameterizes the file path", () => {
    const res = assembleDraftRecipe([
      nav("https://x.test/upload", "Upload", T),
      { op: "attach", url: "https://x.test/upload", title: "T", cues: [{ strategy: "selector", value: "#file" }], fileName: "proof.pdf", pageSensitive: false, ts: T + 1 },
      { type: "done" },
    ], "up", T);
    expect(res.ok).toBe(true);
    const att = res.recipe.steps.find((s) => s.type === "attach");
    expect(att.path).toBe("{{proof_pdf}}");
    expect(res.recipe.params.some((p) => p.name === "proof_pdf")).toBe(true);
  });

  it("trailing done step is always present; empty events are an error", () => {
    const res = assembleDraftRecipe([nav("https://x.test/", "Home", T)], "t", T);
    expect(res.recipe.steps.at(-1).type).toBe("done");
    expect(assembleDraftRecipe([], "x", T).ok).toBe(false);
  });
});

describe("generateRecipePrompt / parseGeneratedRecipe", () => {
  it("the prompt omits param defaults (values stay local) and demands full recipe JSON", () => {
    const draft = assembleDraftRecipe([
      { op: "navigate", url: "https://x.test/form", title: "F", ts: 1, pageSensitive: false },
      { op: "fill", url: "https://x.test/form", title: "F", cues: [{ strategy: "question", value: "Applicant name" }], value: "Ada Lovelace", pageSensitive: false, ts: 2 },
    ], "my flow", 0).recipe;
    const p = generateRecipePrompt(draft);
    expect(p).toContain("## Recipe Draft");
    expect(p).not.toContain("Ada Lovelace");
    expect(p).toContain('"params"');
    expect(p).toContain('"steps"');
    expect(p).toContain("human");
  });

  it("parseGeneratedRecipe extracts a fenced recipe JSON", () => {
    const raw = '```json\n{"params":[],"steps":[{"type":"done"}],"note":"ok"}\n```';
    const res = parseGeneratedRecipe(raw);
    expect(res.ok).toBe(true);
    expect(res.recipe.steps).toHaveLength(1);
    expect(parseGeneratedRecipe("nothing here").ok).toBe(false);
  });
});

// ---- generate-at-runtime fill values (#228) --------------------------------

import { generateValuePrompt } from "../extension/lib/recipes.js";

describe("validateRecipe — generate fills", () => {
  const genStep = {
    type: "fill",
    cues: [cue("question", "RTI Application text")],
    generate: { prompt: "Draft an RTI application to {{department}}." },
  };

  it("accepts a fill with generate and no value", () => {
    const r = validRecipe({
      params: [
        { name: "applicant", type: "string", required: true, question: "Who?" },
        { name: "department", type: "string", required: true, question: "Which department?" },
      ],
    });
    (r.steps as any[])[3] = { ...genStep, cues: [{ strategy: "question", value: "Applicant name" }] };
    const v = validateRecipe(r);
    expect(v.errors).toEqual([]);
  });

  it("rejects value AND generate together, and generate without a prompt", () => {
    const r = validRecipe();
    (r.steps as any[])[3] = { type: "fill", cues: [{ strategy: "selector", value: "#x" }], value: "static", generate: { prompt: "p" } };
    expect(validateRecipe(r).errors.some((e) => e.includes("either value or generate"))).toBe(true);

    const r2 = validRecipe();
    (r2.steps as any[])[3] = { type: "fill", cues: [{ strategy: "selector", value: "#x" }], generate: {} };
    expect(validateRecipe(r2).errors.some((e) => e.includes("prompt"))).toBe(true);
  });

  it("validates maxChars and {{param}} refs inside the prompt + contextFile", () => {
    const r = validRecipe();
    (r.steps as any[])[3] = {
      type: "fill", cues: [{ strategy: "selector", value: "#x" }],
      generate: { prompt: "Use {{department}} and {{bogus}}", maxChars: -5, contextFile: "notes/{{fy}}.md" },
    };
    const v = validateRecipe(r);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("maxChars"))).toBe(true);
    expect(v.errors.some((e) => e.includes("bogus"))).toBe(true);
    // department + fy are unknown too (no params declared beyond applicant)…
    expect(v.errors.some((e) => e.includes("department"))).toBe(true);
  });

  it("substitutes params inside generate.prompt and generate.contextFile", () => {
    const r = validRecipe({
      params: [
        { name: "applicant", type: "string", required: true, question: "Who?" },
        { name: "department", type: "string", required: true, question: "Which department?" },
        { name: "fy", type: "string", required: false, question: "FY", default: "2025-26" },
      ],
    });
    (r.steps as any[])[3] = {
      type: "fill", cues: [{ strategy: "selector", value: "#x" }],
      generate: { prompt: "Draft for {{department}}, FY {{fy}}.", contextFile: "notes/{{fy}}.md", maxChars: 2900 },
    };
    const res = substituteParams(r, { applicant: "Ada", department: "Urban Development" });
    expect(res.ok).toBe(true);
    const gen = (res.recipe.steps[3] as any).generate;
    expect(gen.prompt).toContain("Urban Development");
    expect(gen.prompt).toContain("FY 2025-26");
    expect(gen.contextFile).toBe("notes/2025-26.md");
  });
});

describe("generateValuePrompt", () => {
  it("frames the field-drafting task with the cap and a text-only reply protocol", () => {
    const p = generateValuePrompt({
      type: "fill", cues: [], value: undefined,
      generate: { prompt: "Draft an RTI application to the PIO.", maxChars: 2900 },
    } as any);
    expect(p).toContain("Draft an RTI application to the PIO.");
    expect(p).toContain("2900");
    expect(p).toContain("Respond with only the field text");
  });

  it("omits the cap line when maxChars is absent", () => {
    const p = generateValuePrompt({ type: "fill", cues: [], generate: { prompt: "Say hello" } } as any);
    expect(p).toContain("Say hello");
    expect(p).not.toContain("characters");
  });
});

// ---- Stabilization round 1 (#268/#270) -------------------------------------

describe("assembleDraftRecipe — recorder navigations (#268)", () => {
  const nav = (url: string) => ({ op: "navigate", url, title: "T", pageSensitive: false, cues: [] });

  it("emits navigate steps with origin+pathname expectUrl and dedupes reloads", () => {
    const draft = assembleDraftRecipe([
      nav("https://a.example/form"),
      nav("https://a.example/form"), // page reload — must dedupe
      { op: "fill", url: "https://a.example/form", title: "F", pageSensitive: false, cues: [{ strategy: "question", value: "Applicant name" }], value: "Ada" },
      nav("https://b.example/done?token=zzz"), // query churn — dropped from expectUrl
    ], "multi-page");
    expect(draft.ok).toBe(true);
    const navs = (draft.recipe as any).steps.filter((st: any) => st.type === "navigate");
    expect(navs).toHaveLength(2);
    expect(navs[0].expectUrl).toBe("https://a.example/form");
    expect(navs[1].expectUrl).toBe("https://b.example/done"); // origin+path, no search
    expect(navs[1].url).toBe("https://b.example/done?token=zzz"); // full url kept for the jump
  });

  it("carries the recorded checkbox direction (#270)", () => {
    const draft = assembleDraftRecipe([
      nav("https://a.example/form"),
      { op: "check", url: "https://a.example/form", title: "F", pageSensitive: false, cues: [{ strategy: "question", value: "Terms" }], checked: false },
      { op: "check", url: "https://a.example/form", title: "F", pageSensitive: false, cues: [{ strategy: "question", value: "Newsletter" }], checked: true },
    ], "checkboxes");
    expect(draft.ok).toBe(true);
    const checks = (draft.recipe as any).steps.filter((st: any) => st.type === "check");
    expect(checks).toHaveLength(2);
    expect(checks[0].checked).toBe(false);
    expect(checks[1].checked).toBe(true);
  });
});

describe("recipeProgress — surfaced warnings (#270)", () => {
  it("appends the latest warning to live and terminal lines", () => {
    const run: any = { status: "running", stepIndex: 1, stepsTotal: 3, evidence: [], startedAt: T0, warnings: ['checkpoint "Pay by hand" skipped — postcondition not verified (manual fallback)'] };
    expect(recipeProgress(run, T0 + 60_000)).toContain('⚠ checkpoint "Pay by hand" skipped');
    const clean: any = { status: "running", stepIndex: 1, stepsTotal: 3, evidence: [], startedAt: T0 };
    expect(recipeProgress(clean, T0 + 60_000)).not.toContain("⚠");
  });
});
