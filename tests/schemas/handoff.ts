import { z } from "zod";
import { Cue } from "./recipes.js";

// Handoff (Lane E) — delegate-mode runs where Zo works unattended up to a hard
// boundary. Contract for lib/handoff.js's exported shapes; the run object also
// rides chrome.storage.session (background, item 10), so its shape is a
// persisted contract, not just an in-memory one.

export const HandoffStatus = z.enum([
  "priming", // created, first turn not yet sent
  "running", // loop is executing turns
  "paused", // budget exceeded or user pause — resumable
  "blocked", // parked at the boundary — needs the user
  "done", // Zo called done(); report ready
  "aborted", // user aborted / run tab closed / browser closed
]);
export type HandoffStatus = z.infer<typeof HandoffStatus>;

export const HandoffBoundaryMode = z.enum([
  "readonly", // 0.2.7 reference scenario: navigate/extract/scroll/read only
  "no-submit", // 0.3.0 form scenarios: fill allowed, submit-ish clicks parked
]);
export type HandoffBoundaryMode = z.infer<typeof HandoffBoundaryMode>;

export const HandoffBudget = z.object({
  maxTurns: z.number().int().positive(),
  maxNavigations: z.number().int().positive(),
  maxMinutes: z.number().int().positive(),
});
export type HandoffBudget = z.infer<typeof HandoffBudget>;

export const HandoffUsage = z.object({
  turns: z.number().int().nonnegative(),
  navigations: z.number().int().nonnegative(),
  startedAt: z.number(),
});
export type HandoffUsage = z.infer<typeof HandoffUsage>;

export const ParkedAction = z.object({
  action: z.record(z.unknown()), // the Zo action object, verbatim
  reason: z.string(),
  url: z.string().optional(),
  ts: z.number(),
});
export type ParkedAction = z.infer<typeof ParkedAction>;

// C1 (#289): one compose-sink record — what a handoff turn EXECUTED
// (source:'zo') or had PARKED by the boundary (source:'boundary'). Values are
// stripped at the sink (a fill's invented value never lands here), so the
// record only ever carries targeting cues + flags.
export const HandoffObsRecord = z.object({
  source: z.enum(["zo", "boundary"]),
  op: z.string(), // navigate | click | fill | check | extract
  url: z.string().optional(), // navigate target, else the page URL
  cues: z.array(Cue).optional(),
  submitish: z.boolean().optional(),
  checked: z.boolean().optional(),
  evidenceKey: z.string().optional(),
  label: z.string().optional(),
  reason: z.string().optional(), // boundary parks: why the action was refused
  ts: z.number(),
});
export type HandoffObsRecord = z.infer<typeof HandoffObsRecord>;

export const HandoffRun = z.object({
  runId: z.string().min(1),
  chatId: z.string().min(1),
  goal: z.string().min(1),
  boundaryMode: HandoffBoundaryMode,
  budget: HandoffBudget,
  usage: HandoffUsage,
  status: HandoffStatus,
  pagesVisited: z.array(z.string()),
  parkLog: z.array(ParkedAction),
  // C1 (#289): the compose sink's log — optional so pre-C1 persisted runs
  // (storage.session from an older build) still validate.
  obs: z.array(HandoffObsRecord).optional(),
  stopReason: z.string().optional(),
  // The driven tab (panel-bound at HANDOFF_START). Optional so the pure
  // createRun stays tab-agnostic; the background stamps it.
  tabId: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type HandoffRun = z.infer<typeof HandoffRun>;

export const HandoffTransitionEvent = z.enum([
  "start",
  "pause",
  "resume",
  "block",
  "complete",
  "abort",
]);
export type HandoffTransitionEvent = z.infer<typeof HandoffTransitionEvent>;

export const HandoffTransitionResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), run: HandoffRun }),
  z.object({ ok: z.literal(false), error: z.string(), run: HandoffRun }),
]);
export type HandoffTransitionResult = z.infer<typeof HandoffTransitionResult>;

export const BoundaryDecision = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), reason: z.string() }),
]);
export type BoundaryDecision = z.infer<typeof BoundaryDecision>;
