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
