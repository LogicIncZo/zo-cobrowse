import { z } from "zod";

// Context-policy contracts — validates the output of
// extension/lib/context-policy.js#decideTurn and the conversation state shape
// persisted to chrome.storage.session.

export const ConversationStateSchema = z.object({
  conversationId: z.union([z.string(), z.null()]),
  lastCaptureHash: z.union([z.string(), z.null()]),
  lastCaptureTier: z.union([z.number().int().min(0).max(3), z.null()]),
  turnsSinceFullCapture: z.number().int().min(0),
  // Tab contexts (send-once per tab): { [tabId]: pageHash }. Optional so
  // legacy persisted states still validate.
  tabsSent: z.record(z.string(), z.string()).optional(),
  // Referenced-tab manifest dedup: { [tabId]: contentKey } — an unchanged
  // tab's excerpt is NOT re-sent on follow-ups (manifest line only). Optional
  // so legacy persisted states still validate.
  tabManifestSent: z.record(z.string(), z.string()).optional(),
}).passthrough();
export type ConversationState = z.infer<typeof ConversationStateSchema>;

export const TurnDecisionSchema = z.object({
  effectiveTier: z.number().int().min(0).max(3),
  reason: z.string().min(1),
  attach: z.boolean(),
  newState: ConversationStateSchema,
});
export type TurnDecision = z.infer<typeof TurnDecisionSchema>;
