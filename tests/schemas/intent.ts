import { z } from "zod";

// Intent schema — detectIntent()/shouldDowngradeToJsonDisabled() outputs.
// Deliberately tiny: the classification is a two-value union consumed by the
// context policy (read → tier 0) and buildPrompt (read → markdown downgrade).
// The structural context it feeds is validated in context-policy.ts/prompt.ts.

export const IntentSchema = z.enum(["action", "read"]);

export type Intent = z.infer<typeof IntentSchema>;

/** shouldDowngradeToJsonDisabled() — a boolean, but typed for symmetry. */
export const DowngradeDecisionSchema = z.boolean();
