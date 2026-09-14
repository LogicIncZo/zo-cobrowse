import { z } from "zod";

// Recipes (#220) — repeatable multi-page workflows as a first-class primitive.
// Contract for lib/recipes.js's exported shapes. The Recipe artifact is
// persisted (workspace JSON, storage.local learned-recipes store) and
// RecipeRun rides chrome.storage.session (background player), so both are
// persisted contracts, not just in-memory ones.

export const CueStrategy = z.enum([
  "selector",
  "text",
  "label",
  "aria",
  "placeholder",
  "question",
]);
export type CueStrategy = z.infer<typeof CueStrategy>;

export const Cue = z.object({
  strategy: CueStrategy,
  value: z.string().min(1),
});
export type Cue = z.infer<typeof Cue>;

export const ParamType = z.enum(["string", "number", "url"]);
export type ParamType = z.infer<typeof ParamType>;

export const RecipeParam = z.object({
  name: z.string().min(1),
  type: ParamType,
  required: z.boolean(),
  question: z.string(), // prompt shown on the params card (required only when required)
  default: z.string().optional(),
});
export type RecipeParam = z.infer<typeof RecipeParam>;

export const ResumeOn = z
  .object({
    url: z.string().optional(), // substring/glob-ish URL match
    cue: Cue.optional(), // element must be present
  })
  .refine((r) => r.url !== undefined || r.cue !== undefined, {
    message: "resumeOn needs a url or cue postcondition",
  });
export type ResumeOn = z.infer<typeof ResumeOn>;

export const NavigateStep = z.object({
  type: z.literal("navigate"),
  url: z.string().min(1),
  expectUrl: z.string().optional(),
});
export const FillStep = z.object({
  type: z.literal("fill"),
  cues: z.array(Cue).min(1),
  value: z.string(), // may be empty (clearing); may contain {{param}}
});
export const ClickStep = z.object({
  type: z.literal("click"),
  cues: z.array(Cue).min(1),
  submitish: z.boolean().optional(),
});
export const CheckStep = z.object({
  type: z.literal("check"),
  cues: z.array(Cue).min(1),
  checked: z.boolean().optional(),
});
export const AttachStep = z.object({
  type: z.literal("attach"),
  cues: z.array(Cue).min(1), // targets the <input type=file>
  path: z.string().min(1), // workspace file → base64 → DataTransfer
});
export const ExtractStep = z.object({
  type: z.literal("extract"),
  cues: z.array(Cue).min(1),
  attribute: z.string().optional(),
  evidenceKey: z.string().min(1),
  label: z.string().min(1),
});
export const WaitForStep = z
  .object({
    type: z.literal("waitFor"),
    cue: Cue.optional(),
    url: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .refine((s) => s.cue !== undefined || s.url !== undefined, {
    message: "waitFor needs a cue or url condition",
  });
export const HumanStep = z.object({
  type: z.literal("human"),
  title: z.string().min(1),
  instructions: z.string().min(1),
  resumeOn: ResumeOn,
  timeoutMinutes: z.number().positive().optional(),
});
export const DoneStep = z.object({
  type: z.literal("done"),
  message: z.string().optional(),
});

export const RecipeStep = z.discriminatedUnion("type", [
  NavigateStep,
  FillStep,
  ClickStep,
  CheckStep,
  AttachStep,
  ExtractStep,
  WaitForStep,
  HumanStep,
  DoneStep,
]);
export type RecipeStep = z.infer<typeof RecipeStep>;

export const RECIPE_STEP_TYPES = [
  "navigate",
  "fill",
  "click",
  "check",
  "attach",
  "extract",
  "waitFor",
  "human",
  "done",
] as const;

export const Recipe = z.object({
  id: z.string().min(1), // 'rcp-<slug>'
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/), // semver, bumped on heal/param changes
  origin: z.string().min(1), // workspace path | 'local' | 'recorded'
  draft: z.boolean().optional(), // learned, not yet cleaned/reviewed
  createdAt: z.number(),
  updatedAt: z.number(),
  params: z.array(RecipeParam),
  steps: z.array(RecipeStep).min(1),
});
export type Recipe = z.infer<typeof Recipe>;

export const RecipeValidation = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  z.object({
    ok: z.literal(false),
    errors: z.array(z.string()).min(1),
    warnings: z.array(z.string()),
  }),
]);
export type RecipeValidation = z.infer<typeof RecipeValidation>;

export const RecipeRunStatus = z.enum([
  "running",
  "waiting_human",
  "healing",
  "paused",
  "blocked",
  "done",
  "aborted",
]);
export type RecipeRunStatus = z.infer<typeof RecipeRunStatus>;

export const RecipeEvidence = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  ts: z.number(),
});
export type RecipeEvidence = z.infer<typeof RecipeEvidence>;

export const RecipeRun = z.object({
  runId: z.string().min(1), // 'rec-…'
  recipeId: z.string().min(1),
  name: z.string().min(1),
  origin: z.string().min(1), // workspace path | 'local:<name>'
  version: z.string(),
  chatId: z.string().min(1),
  status: RecipeRunStatus,
  stepIndex: z.number().int().nonnegative(), // index of the current/next step
  stepsTotal: z.number().int().positive(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  evidence: z.array(RecipeEvidence),
  healCount: z.number().int().nonnegative(),
  stopReason: z.string().optional(),
  humanTitle: z.string().optional(), // title of the pending human checkpoint
  // The driven tab (stamped by background at RECIPE_START); optional so the
  // pure helpers stay tab-agnostic.
  tabId: z.number().optional(),
  startedAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RecipeRun = z.infer<typeof RecipeRun>;
