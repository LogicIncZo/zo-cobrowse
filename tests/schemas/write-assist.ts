import { z } from "zod";

// Textarea write-assist contracts — the pure lib's inputs/outputs
// (extension/lib/write-assist.js). The ENHANCE_TEXT message envelope itself is
// passthrough in schemas/messages.ts; these validate the lib functions.

/** Field metadata the content script gathers about the focused textarea. */
export const EnhanceFieldSchema = z.object({
  label: z.string(),
  placeholder: z.string(),
  maxLength: z.number().nullable(),
});

/** Page cues (token-cheap: URL/title only, never DOM text). */
export const EnhancePageSchema = z.object({
  url: z.string(),
  title: z.string(),
});

/** Input shape for buildEnhancePrompt. */
export const EnhanceInputSchema = z.object({
  text: z.string(),
  instruction: z.string().optional(),
  field: EnhanceFieldSchema.partial().optional(),
  page: EnhancePageSchema.partial().optional(),
});

/** buildEnhancePrompt returns a non-empty prompt string. */
export const EnhancePromptSchema = z.string().min(1);

/** parseEnhanceResponse returns bare text. */
export const ParsedEnhanceSchema = z.object({
  text: z.string(),
});

/** isEnhanceableField verdict. */
export const EnhanceVerdictSchema = z.boolean();
