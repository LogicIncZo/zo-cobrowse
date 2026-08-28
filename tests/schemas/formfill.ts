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
