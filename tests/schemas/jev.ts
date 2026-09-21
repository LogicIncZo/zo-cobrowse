import { z } from "zod";

// Jev (TypeSafe AI "System One") contract — 0.3.4 Lane J.
// Wire shapes per docs.typesafe.ai/api (captured 2026-09-20, live-verified
// by tests/test-prompts/probe-jev.ts). The extension runtime stays plain JS;
// these schemas are the test-layer regression net for lib/jev.js.

export const JevNoulAnswer = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});

export const JevChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const JevScoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const JevAnswer = z.discriminatedUnion("type", [
  JevNoulAnswer,
  JevChoiceAnswer,
  JevScoreAnswer,
]);

export const JevQuestion = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: z.string().min(1),
    criteria: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal("choice"),
    instructions: z.string().min(1),
    // The 255-option vendor cap is enforced by lib/jev.js (MAX_CHOICE_OPTIONS).
    criteria: z.record(z.string(), z.string()),
  }),
  z.object({
    type: z.literal("score"),
    instructions: z.string().min(1),
    criteria: z.array(z.string()).min(2).max(10),
  }),
]);

export const JevDecideRequest = z.object({
  model: z.string().min(1),
  state: z.union([z.string(), z.record(z.string(), z.any()), z.array(z.any())]),
  questions: z.record(z.string(), JevQuestion),
});

export const JevDecideResponse = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), JevAnswer),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

/** JEV_TEST reply from the background (options Test-Jev button). */
export const JevTestResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    latencyMs: z.number().nonnegative(),
    model: z.string().optional(),
    usage: z.any().optional(),
    answer: JevAnswer.nullable().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

/** The per-hook routing verdict the executor records (Lane J2 consumes). */
export const JevRoutingDecision = z.object({
  act: z.boolean(),
  confidence: z.number(),
  threshold: z.number(),
  reason: z.string(),
});

export type JevAnswerT = z.infer<typeof JevAnswer>;
export type JevDecideRequestT = z.infer<typeof JevDecideRequest>;
export type JevDecideResponseT = z.infer<typeof JevDecideResponse>;
export type JevTestResultT = z.infer<typeof JevTestResult>;
