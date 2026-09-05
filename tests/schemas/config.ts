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
}).passthrough();

export type Config = z.infer<typeof ConfigSchema>;
