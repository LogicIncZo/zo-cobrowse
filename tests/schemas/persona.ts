import { z } from "zod";

// #415 persona_id lane contracts — the durable per-Mode persona map
// (storage.local) and the session guard state written by background.js's
// ensurePersonas. The decision logic itself is validated behaviorally in
// tests/persona-sync.test.ts.

export const PersonaEntrySchema = z.object({
  personaId: z.string().min(1),
  /** The exact systemPrompt the persona was created from — byte-match check at send time. */
  prompt: z.string(),
  /** `zo-cobrowse: <modeId> · <hash>` — embeds the prompt hash, adopt-by-name is prompt-safe. */
  name: z.string().min(1),
});
export type PersonaEntry = z.infer<typeof PersonaEntrySchema>;

export const PersonaMapSchema = z.record(z.string(), PersonaEntrySchema);
export type PersonaMap = z.infer<typeof PersonaMapSchema>;

export const PersonaStateSchema = z.object({
  checkedVersion: z.string(),
});
export type PersonaState = z.infer<typeof PersonaStateSchema>;
