import { z } from "zod";

// swamp-factory schema — the contract for scripts/swamp/factory.yaml, the
// @swamp/software-factory definition that drives the 0.2.8 per-fix loop as a
// gated state machine (docs/swamp-factory.md). The extension compiles
// artifact/evidence payload schemas from a JSON-Schema-flavored subset at
// runtime; we model exactly the subset the committed definition uses, so a
// hand-edit that breaks the machine fails `bun run verify` instead of
// surfacing mid-loop as a swamp validate error.

/** The gate vocabulary the committed definition is allowed to use. */
export const GateTypeSchema = z.enum([
  "artifact-exists",
  "artifact-fresh",
  "findings-clear",
  "human-approval",
  "evidence-recorded",
  "cooldown",
  "max-cycles",
  "workflow-succeeded",
  "cel",
]);
export type GateType = z.infer<typeof GateTypeSchema>;

/** How a stage's work gets done (swamp software-factory work modes). */
export const WorkModeSchema = z.enum(["interactive", "dispatch", "workflow", "method"]);
export type WorkMode = z.infer<typeof WorkModeSchema>;

/** The JSON-Schema-flavored subset used by the committed definition. */
export type JsonSchemaNode = {
  type: string;
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  minLength?: number;
  minItems?: number;
};
export const JsonSchemaNodeSchema: z.ZodType<JsonSchemaNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    required: z.array(z.string()).optional(),
    properties: z.record(z.string(), JsonSchemaNodeSchema).optional(),
    items: JsonSchemaNodeSchema.optional(),
    minLength: z.number().optional(),
    minItems: z.number().optional(),
  }),
);

/** Per-gate config, discriminated on `type` — mirrors the engine's parameters. */
export const GateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("artifact-exists"),
    config: z.object({ artifact: z.string().min(1) }).strict(),
  }),
  z.object({
    type: z.literal("artifact-fresh"),
    config: z
      .object({ artifact: z.string().min(1), recordedThisCycle: z.boolean().optional() })
      .strict(),
  }),
  z.object({
    type: z.literal("findings-clear"),
    config: z
      .object({ artifact: z.string().min(1), blocking: z.array(z.string()).optional() })
      .strict(),
  }),
  z.object({
    type: z.literal("human-approval"),
    config: z.object({ id: z.string().min(1) }).strict(),
  }),
  z.object({
    type: z.literal("evidence-recorded"),
    config: z
      .object({
        name: z.string().min(1),
        requireField: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
      })
      .strict(),
  }),
  z.object({
    type: z.literal("cooldown"),
    config: z
      .object({
        afterEvidence: z.string().optional(),
        afterArtifact: z.string().optional(),
        seconds: z.number(),
      })
      .strict(),
  }),
  z.object({
    type: z.literal("max-cycles"),
    config: z.object({ stage: z.string(), limit: z.number(), invert: z.boolean().optional() }).strict(),
  }),
  z.object({
    type: z.literal("workflow-succeeded"),
    config: z.object({ workflow: z.string().min(1) }).strict(),
  }),
  z.object({
    type: z.literal("cel"),
    config: z.object({ expr: z.string().min(1), message: z.string().optional() }).strict(),
  }),
]);
export type Gate = z.infer<typeof GateSchema>;

export const TransitionSchema = z
  .object({
    name: z.string().min(1),
    to: z.string().min(1),
    gates: z.array(GateSchema).optional(),
  })
  .strict();
export type Transition = z.infer<typeof TransitionSchema>;

export const WorkSchema = z
  .object({
    mode: WorkModeSchema,
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    constraints: z.string().optional(),
    command: z.string().optional(),
    workflow: z
      .object({ name: z.string().min(1), inputs: z.record(z.string(), z.string()).optional() })
      .strict()
      .optional(),
    resultEvidence: z.string().optional(),
    method: z
      .object({
        modelIdOrName: z.string().min(1),
        methodName: z.string().min(1),
        inputs: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Work = z.infer<typeof WorkSchema>;

export const ArtifactSchema = z
  .object({
    name: z.string().min(1),
    kind: z.literal("findings").optional(),
    reviews: z.string().optional(),
    schema: JsonSchemaNodeSchema.optional(),
  })
  .strict();
export type ArtifactDecl = z.infer<typeof ArtifactSchema>;

export const EvidenceSchema = z
  .object({
    name: z.string().min(1),
    schema: JsonSchemaNodeSchema.optional(),
  })
  .strict();
export type EvidenceDecl = z.infer<typeof EvidenceSchema>;

export const StageSchema = z
  .object({
    id: z.string().min(1),
    initial: z.boolean().optional(),
    terminal: z.boolean().optional(),
    description: z.string().optional(),
    maxCycles: z.number().int().min(1).optional(),
    work: WorkSchema.optional(),
    artifacts: z.array(ArtifactSchema).optional(),
    evidence: z.array(EvidenceSchema).optional(),
    transitions: z.array(TransitionSchema).optional(),
  })
  .strict();
export type Stage = z.infer<typeof StageSchema>;

/** The full committed definition: everything that pastes under globalArguments. */
export const FactoryDefSchema = z
  .object({
    stages: z.array(StageSchema).min(1),
    globalTransitions: z.array(TransitionSchema).optional(),
  })
  .strict();
export type FactoryDef = z.infer<typeof FactoryDefSchema>;
