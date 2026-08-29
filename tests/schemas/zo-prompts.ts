import { z } from "zod";

// zo-prompts schema — the external-data boundary of the utility one-shots.
// The builders themselves return plain strings (validated for content by the
// prompt-evals harness); what needs a contract is the REPLY Zo sends to
// buildGenerateModePrompt: background.generateMode JSON.parses it and feeds
// it to presetToMode, so a shape drift here silently corrupts generated Modes.

export const GenerateModeReplySchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    icon: z.string(),
    systemPrompt: z.string(),
    instructions: z.string(),
    /** 0 = URL only … 3 = +screenshot (presetToMode backfills garbage). */
    contextTier: z.number().int(),
    expectJson: z.boolean(),
  })
  .passthrough();

export type GenerateModeReply = z.infer<typeof GenerateModeReplySchema>;

/** generateMode()'s return shape — success carries a resolved custom Mode;
 *  failure is `{ error }` (no `success` key — the discriminated-union
 *  discriminator is absent on that branch, so this is a plain union). */
export const GenerateModeResultSchema = z.union([
  z.object({
    success: z.literal(true),
    mode: z.object({ id: z.string().min(1), builtin: z.literal(false) }).passthrough(),
  }),
  z.object({ error: z.string().min(1) }).passthrough(),
]);
