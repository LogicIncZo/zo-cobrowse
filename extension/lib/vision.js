// Vision gating — does the selected model actually accept images?
// Pure logic, no chrome.* or fetch dependencies. The background owns the
// network half (fetchModelCatalog); this module owns the decision: given a
// catalog entry + the selected model name, should we bother capturing a
// screenshot?
//
// Screenshots are expensive (captureVisibleTab is a round-trip through the
// compositor, and the base64 data URL bloats the prompt). Tier 3 already
// gates on the Mode; this adds a second gate on the MODEL: if the model Zo
// will route to can't process images, the capture is pure waste.

/** TTL for the cached catalog (ms). The catalog is no-auth + cheap, but we
 * don't want to block every tier-3 turn on a network call. 5 min matches the
 * relay's own cache window. */
export const CATALOG_TTL_MS = 5 * 60 * 1000;

/** The field name on each catalog entry. Verified against the live API. */
export const VISION_FIELD = 'supports_images';

/**
 * Find the catalog entry for a model name. /models/catalog keys entries on
 * `value` (public identifier, e.g. 'zo:openai/gpt-5.4') while /models/available
 * — where config.zoModel comes from — uses `model_name` for the same
 * identifier format, so match either. The selected model is `config.zoModel`.
 *
 * @param {Array} catalog — the `models` array from /models/catalog
 * @param {string} modelName — config.zoModel (may be '' for API default)
 * @returns {object|null} the entry, or null when not found / no model set
 */
export function findModelEntry(catalog, modelName) {
  if (!Array.isArray(catalog) || !modelName) return null;
  return (
    catalog.find((m) => m && (m.model_name === modelName || m.value === modelName)) ||
    null
  );
}

/**
 * Does a catalog entry declare image support? Defensive: missing field =
 * unknown → we conservatively allow the screenshot (the old behavior) rather
 * than silently degrading tier 3 for models we haven't cataloged.
 *
 * @returns {'yes'|'no'|'unknown'}
 */
export function modelVisionSupport(entry) {
  if (!entry) return 'unknown';
  const v = entry[VISION_FIELD];
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return 'unknown';
}

/**
 * The gating decision: should we capture a screenshot for this turn?
 *
 * Tier 3 + enableScreenshots already said yes. This adds: only if the
 * selected model can plausibly consume an image. When support is 'no' we
 * skip the capture (token savings); when 'unknown' we capture anyway
 * (backward-compatible — tier 3 worked before this gate existed).
 *
 * @param {object|null} entry — findModelEntry(catalog, modelName)
 * @param {object} opts — { tier, enableScreenshots }
 * @returns {boolean}
 */
export function shouldCaptureScreenshot(entry, opts) {
  const { tier = 0, enableScreenshots = true } = opts || {};
  if (tier < 3) return false;
  if (enableScreenshots === false) return false;
  const support = modelVisionSupport(entry);
  if (support === 'no') return false;
  return true; // 'yes' or 'unknown' both capture
}

/**
 * Does the cached catalog need refreshing? Null (never fetched) or stale.
 */
export function catalogIsStale(cachedAt, now = Date.now()) {
  if (!cachedAt) return true;
  return (now - cachedAt) > CATALOG_TTL_MS;
}

/**
 * Build a human-readable suggestion for the sidepanel when the user picks
 * Visual mode without a vision-capable model. Returns null when no
 * suggestion is warranted (model is vision-capable, or no catalog yet).
 */
export function visionModelSuggestion(catalog, modelName) {
  if (!modelName) return null;
  const entry = findModelEntry(catalog, modelName);
  const support = modelVisionSupport(entry);
  if (support !== 'no') return null;

  // Suggest the first vision-capable model in the catalog, if any.
  const visionModel = (catalog || []).find((m) => m && m[VISION_FIELD] === true);
  if (visionModel) {
    return {
      kind: 'suggest',
      currentModel: modelName,
      reason: `“${entry.label || modelName}” doesn't support images.`,
      suggestedModel: visionModel.model_name || visionModel.value,
      suggestedLabel: visionModel.label || visionModel.model_name || visionModel.value,
    };
  }
  return {
    kind: 'warn',
    currentModel: modelName,
    reason: `“${entry.label || modelName}” doesn't support images. Visual mode needs a vision model to see the page.`,
  };
}
