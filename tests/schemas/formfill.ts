import { z } from "zod";

export const SensitivityVerdictSchema = z.object({
  sensitive: z.boolean(),
  reasons: z.array(z.string()),
});

export const ReviewRowSchema = z.object({
  target: z.string(),
  value: z.string(),
  type: z.string(),
  secret: z.boolean(),
  redacted: z.string(),
});

/** One join row of the Run-All fill batch (fillBatchRows output). */
export const FillBatchRowSchema = z.object({
  kind: z.union([z.literal("fill_form"), z.literal("fill")]),
  ai: z.number().int().nonnegative(),
  vi: z.number().int().nonnegative().nullable(),
  target: z.string(),
  value: z.string(),
  type: z.string(),
  secret: z.boolean(),
  redacted: z.string(),
}).passthrough();

export type FillBatchRow = z.infer<typeof FillBatchRowSchema>;
