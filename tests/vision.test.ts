import { describe, it, expect } from "bun:test";
import { ModelCatalogSchema, VisionSuggestionSchema } from "./schemas/vision.js";
import {
  CATALOG_TTL_MS,
  VISION_FIELD,
  findModelEntry,
  modelVisionSupport,
  shouldCaptureScreenshot,
  catalogIsStale,
  visionModelSuggestion,
} from "../extension/lib/vision.js";

const CATALOG = [
  { model_name: "text-only", label: "Text Only", vendor: "vendor", [VISION_FIELD]: false },
  { model_name: "vision-pro", label: "Vision Pro", vendor: "vendor", [VISION_FIELD]: true },
  { model_name: "mystery", label: "Mystery", vendor: "vendor" }, // no supports_images field
];

// /models/catalog entries are keyed on `value` (public identifier) with no
// model_name field — verified against the live API + openapi baseline.
const CATALOG_BY_VALUE = [
  { value: "zo:vendor/text-only", label: "Text Only", [VISION_FIELD]: false },
  { value: "zo:vendor/vision-pro", label: "Vision Pro", [VISION_FIELD]: true },
];

describe("vision gating — constants", () => {
  it("caches the catalog for 5 minutes", () => {
    expect(CATALOG_TTL_MS).toBe(5 * 60 * 1000);
  });
  it("uses the verified API field name", () => {
    expect(VISION_FIELD).toBe("supports_images");
  });
});

describe("findModelEntry", () => {
  it("finds the entry by model_name", () => {
    expect(findModelEntry(CATALOG, "vision-pro")?.label).toBe("Vision Pro");
    expect(findModelEntry(CATALOG, "text-only")?.label).toBe("Text Only");
  });
  it("returns null for no/empty model name or missing entry", () => {
    expect(findModelEntry(CATALOG, "")).toBeNull();
    expect(findModelEntry(CATALOG, "nonexistent")).toBeNull();
    expect(findModelEntry(null, "vision-pro")).toBeNull();
    expect(findModelEntry([], "vision-pro")).toBeNull();
  });
  it("matches value-keyed catalog entries (/models/catalog shape)", () => {
    expect(findModelEntry(CATALOG_BY_VALUE, "zo:vendor/vision-pro")?.label).toBe("Vision Pro");
    expect(findModelEntry(CATALOG_BY_VALUE, "zo:vendor/text-only")?.label).toBe("Text Only");
    expect(findModelEntry(CATALOG_BY_VALUE, "zo:vendor/missing")).toBeNull();
  });
  it("gates capture on value-keyed entries too", () => {
    expect(shouldCaptureScreenshot(CATALOG_BY_VALUE[1], { tier: 3, enableScreenshots: true })).toBe(true);
    expect(shouldCaptureScreenshot(CATALOG_BY_VALUE[0], { tier: 3, enableScreenshots: true })).toBe(false);
  });
  it("suggests a model using value when model_name is absent", () => {
    const s = visionModelSuggestion(CATALOG_BY_VALUE, "zo:vendor/text-only");
    expect(s.kind).toBe("suggest");
    expect(s.suggestedModel).toBe("zo:vendor/vision-pro");
    expect(s.suggestedLabel).toBe("Vision Pro");
  });
});

describe("modelVisionSupport", () => {
  it("returns 'yes' for supports_images=true", () => {
    expect(modelVisionSupport(CATALOG[1])).toBe("yes");
  });
  it("returns 'no' for supports_images=false", () => {
    expect(modelVisionSupport(CATALOG[0])).toBe("no");
  });
  it("returns 'unknown' when the field is missing", () => {
    expect(modelVisionSupport(CATALOG[2])).toBe("unknown");
  });
  it("returns 'unknown' for null entry", () => {
    expect(modelVisionSupport(null)).toBe("unknown");
  });
});

describe("shouldCaptureScreenshot", () => {
  it("captures for a vision model at tier 3", () => {
    expect(shouldCaptureScreenshot(CATALOG[1], { tier: 3, enableScreenshots: true })).toBe(true);
  });
  it("captures for unknown support (backward-compatible)", () => {
    expect(shouldCaptureScreenshot(CATALOG[2], { tier: 3, enableScreenshots: true })).toBe(true);
    expect(shouldCaptureScreenshot(null, { tier: 3, enableScreenshots: true })).toBe(true);
  });
  it("skips capture for a non-vision model at tier 3 (token savings)", () => {
    expect(shouldCaptureScreenshot(CATALOG[0], { tier: 3, enableScreenshots: true })).toBe(false);
  });
  it("skips capture below tier 3 regardless of model", () => {
    expect(shouldCaptureScreenshot(CATALOG[1], { tier: 2, enableScreenshots: true })).toBe(false);
    expect(shouldCaptureScreenshot(CATALOG[1], { tier: 0, enableScreenshots: true })).toBe(false);
  });
  it("skips capture when screenshots are globally disabled", () => {
    expect(shouldCaptureScreenshot(CATALOG[1], { tier: 3, enableScreenshots: false })).toBe(false);
  });
});

describe("catalogIsStale", () => {
  it("is stale when never fetched", () => {
    expect(catalogIsStale(null)).toBe(true);
    expect(catalogIsStale(0)).toBe(true);
  });
  it("is fresh within the TTL window", () => {
    const now = Date.now();
    expect(catalogIsStale(now - 1000, now)).toBe(false);
    expect(catalogIsStale(now - CATALOG_TTL_MS + 1000, now)).toBe(false);
  });
  it("is stale past the TTL window", () => {
    const now = Date.now();
    expect(catalogIsStale(now - CATALOG_TTL_MS - 1, now)).toBe(true);
  });
});

describe("visionModelSuggestion", () => {
  it("suggests a vision-capable model when the selected model can't see", () => {
    const s = visionModelSuggestion(CATALOG, "text-only");
    expect(s.kind).toBe("suggest");
    expect(s.currentModel).toBe("text-only");
    expect(s.suggestedModel).toBe("vision-pro");
    expect(s.suggestedLabel).toBe("Vision Pro");
  });
  it("returns null when the selected model IS vision-capable", () => {
    expect(visionModelSuggestion(CATALOG, "vision-pro")).toBeNull();
  });
  it("returns null when the model is unknown (no false claim)", () => {
    expect(visionModelSuggestion(CATALOG, "mystery")).toBeNull();
  });
  it("returns null when no model is selected", () => {
    expect(visionModelSuggestion(CATALOG, "")).toBeNull();
    expect(visionModelSuggestion(CATALOG, null)).toBeNull();
  });
  it("warns (no suggestion) when no vision model exists in the catalog", () => {
    const textOnlyCatalog = [{ model_name: "text", label: "Text", [VISION_FIELD]: false }];
    const s = visionModelSuggestion(textOnlyCatalog, "text");
    expect(s.kind).toBe("warn");
    expect(s.currentModel).toBe("text");
    expect(s).not.toHaveProperty("suggestedModel");
  });
});

// ---- schema conformance (tests/schemas/vision.ts) ----

describe("vision — schema conformance", () => {
  it("the CATALOG fixture satisfies ModelCatalogSchema (live upstream shape)", () => {
    const parsed = ModelCatalogSchema.safeParse(CATALOG);
    if (!parsed.success) throw new Error(`CATALOG fixture failed schema:\n${parsed.error.message}`);
  });

  it("every visionModelSuggestion output satisfies the discriminated union", () => {
    const inputs: Array<[unknown, string]> = [
      [CATALOG, "text-only"],
      [CATALOG, ""],
      [CATALOG, null],
      [{ model_name: "text", label: "Text", supports_images: false }, "text"],
      [null, "anything"],
    ];
    for (const [catalog, model] of inputs) {
      const s = visionModelSuggestion(catalog as never, model as string);
      if (s === null) continue;
      const parsed = VisionSuggestionSchema.safeParse(s);
      if (!parsed.success) throw new Error(`suggestion(${model}) failed schema:\n${parsed.error.message}`);
    }
  });
});
