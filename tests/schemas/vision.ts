import { z } from "zod";

// Vision schema — /models/catalog entries + the vision gate's outputs.
// The catalog is LIVE upstream data (keys on `value`, not model_name —
// verified 2026-08-29); entries carry extra vendor fields, so everything is
// optional + passthrough. The gate's own outputs are strict.

export const ModelCatalogEntrySchema = z
  .object({
    /** Public identifier — /models/catalog keys entries on this. */
    value: z.string().optional(),
    /** Same identifier format — this is what /models/available + config.zoModel use. */
    model_name: z.string().optional(),
    label: z.string().optional(),
    supports_images: z.boolean().optional(),
  })
  .passthrough();

export const ModelCatalogSchema = z.array(ModelCatalogEntrySchema);

export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

/** modelVisionSupport() output. */
export const VisionSupportSchema = z.enum(["yes", "no", "unknown"]);

/** visionModelSuggestion() output — discriminated on `kind`. */
export const VisionSuggestionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("suggest"),
    currentModel: z.string(),
    reason: z.string().min(1),
    suggestedModel: z.string().min(1),
    suggestedLabel: z.string().min(1),
  }),
  z.object({
    kind: z.literal("warn"),
    currentModel: z.string(),
    reason: z.string().min(1),
  }),
]);

export type VisionSuggestion = z.infer<typeof VisionSuggestionSchema>;
