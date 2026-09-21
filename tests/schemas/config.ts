import { z } from "zod";

// Config schema — validates the DEFAULTS object in background.js and the
// shape persisted to chrome.storage.sync.

export const ConfigSchema = z.object({
  zoApiUrl: z.string().url(),
  zoModel: z.string(),
  zoSpaceEndpoint: z.string(),
  zoWebOrigin: z.string(), // Zo web UI origin; '' = Open-in-Zo off (0.2.8.0)
  // Zo username slug (#339) — derivation source for the two hosts above; the
  // hosts themselves stay user-overridable (override-not-rewrite).
  zoUsername: z.string(),
  // Jev (0.3.4 Lane J) — ships dark; thresholds are per-type (noul vs choice
  // confidences are not comparable per the vendor's model notes).
  jevEnabled: z.boolean(),
  jevModel: z.string(),
  jevPickConfidence: z.number().min(0).max(1),
  jevDoneConfidence: z.number().min(0).max(1),
  jevApiKey: z.string(),
  jevApiUrl: z.string(),
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
