import { z } from "zod";

// Tab-context contracts — validates the outputs of
// extension/lib/tab-contexts.js (the "tabs as contexts" feature: referenced
// tabs travel as manifest + excerpt; full content is pulled on demand via the
// `read_tab` action). See docs/superpowers/specs/2026-08-14-tab-contexts-design.md

/**
 * One referenced tab, captured by the background at send time and carried on
 * the ASK_ZO payload. `ref` (T1…Tn) is assigned by the sidepanel in strip
 * order and stays stable for the turn.
 */
export const TabContextSchema = z.object({
  tabId: z.number().int(),
  ref: z.string().regex(/^T\d+$/),
  title: z.string(),
  url: z.string(),
  host: z.string(),
  textLength: z.number().int().min(0),
  elementCount: z.number().int().min(0),
  excerpt: z.string(),
  isActive: z.boolean(),
  available: z.boolean(),
  // Send-once excerpt dedup: the tab's excerpt was already sent to Zo at this
  // content key, so the manifest renders "already provided above" and the
  // excerpt drops (conversation threading retains it). Optional so legacy
  // producers (without the dedup) still validate.
  pointerOnly: z.boolean().optional(),
});
export type TabContext = z.infer<typeof TabContextSchema>;

/** The rendered `## Referenced Tabs` manifest + the ref→tabId mapping. */
export const ManifestEntrySchema = z.object({
  ref: z.string().regex(/^T\d+$/),
  tabId: z.number().int(),
  line: z.string().min(1),
  excerptLine: z.string().optional(),
});
export const ManifestResultSchema = z.object({
  rendered: z.string(),
  entries: z.array(ManifestEntrySchema),
});
export type ManifestResult = z.infer<typeof ManifestResultSchema>;

/** The new action Zo returns when it needs a referenced tab's full content. */
export const ReadTabActionSchema = z.object({
  type: z.literal("read_tab"),
  ref: z.string().min(1),
});
export type ReadTabAction = z.infer<typeof ReadTabActionSchema>;

/** Discriminated kind for the auto follow-up input a read_tab cycle produces. */
export const FollowUpKind = z.enum(["content", "unavailable", "duplicate", "budget", "blank"]);
export const FollowUpResultSchema = z.object({
  input: z.string().min(1),
  kind: FollowUpKind,
});
export type FollowUpResult = z.infer<typeof FollowUpResultSchema>;

/** Persisted on the user history entry so mention pills survive reloads. */
export const TabRefSchema = z.object({
  ref: z.string().regex(/^T\d+$/),
  host: z.string(),
  title: z.string(),
});
export const TabRefArray = z.array(TabRefSchema);
