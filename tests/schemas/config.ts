import { z } from "zod";

// Config schema — validates the DEFAULTS object in background.js and the
// shape persisted to chrome.storage.sync.

export const ConfigSchema = z.object({
  zoApiUrl: z.string().url(),
  zoModel: z.string(),
  zoSpaceEndpoint: z.string(),
  zoWebOrigin: z.string(), // Zo web UI origin; '' = Open-in-Zo off (0.2.8.0)
  zoPersonaId: z.string(),
  zoActiveMode: z.string(),
  zoAccessToken: z.string(),
  enableScreenshots: z.boolean(),
  enabledMenus: z.record(z.string(), z.boolean()),
  // !handoff run budget (#158) — config-resident so it is user-tunable.
  cobrowse_handoff_budget: z.object({
    maxTurns: z.number().int().positive(),
    maxNavigations: z.number().int().positive(),
    maxMinutes: z.number().positive(),
  }).optional(),
}).passthrough();

export type Config = z.infer<typeof ConfigSchema>;
