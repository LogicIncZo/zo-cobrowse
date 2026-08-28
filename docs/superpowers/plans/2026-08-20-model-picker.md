# Model Picker (per-chat models + catalog badges) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing global `#model-select` into a per-chat model override with catalog-sourced badges (vision / free / deprecated), and make the options page list models before a token is saved.

**Architecture:** A new pure module `extension/lib/models.js` merges the authed `LIST_MODELS` list (spine — what the API accepts) with the no-auth catalog (`GET_VISION_CATALOG`, cached for the vision gate) into picker rows. The sidepanel persists the selection on the conversation (`conv.modelName`) and sends the effective value on the existing `ASK_ZO.modelName` field — the background already honors it, zero background prompt-path changes. The options page swaps its hardcoded authed fetch for the catalog via the background handler.

**Tech Stack:** Chrome MV3 (classic-script options page, module sidepanel), bun:test, Zod. Spec: `docs/superpowers/specs/2026-08-20-model-picker-design.md`.

## Global Constraints

- `extension/lib/*.js` = pure ES modules: no `chrome.*`, no DOM, no `fetch`. Network stays in background.js.
- Extension JS uses single quotes; tests use double quotes + `bun:test`.
- Schemas first: every new shape gets a Zod schema in `tests/schemas/` and unit tests validate against it.
- No new message types (`LIST_MODELS` + `GET_VISION_CATALOG` already exist in `tests/schemas/messages.ts`).
- `ASK_ZO` must keep working with no model set (`undefined` → API default). Never block sending on picker failures.
- Verify gate: `bun run verify` must pass before every commit (pre-commit hook runs it).

---

### Task 1: `lib/models.js` — merge helper + badges

**Files:**
- Create: `extension/lib/models.js`
- Create: `tests/schemas/models.ts`
- Test: `tests/models.test.ts`

**Interfaces:**
- Consumes: `findModelEntry(catalog, modelName)`, `modelVisionSupport(entry)` from `extension/lib/vision.js` (existing, exported).
- Produces: `buildModelPicker(available, catalog, catalogMeta)` → `{ defaultModel: string, models: PickerModel[] }` where `PickerModel = { model_name, label, vision: 'yes'|'no'|'unknown', free: boolean, deprecated: false | { successor: string } }`; `modelBadge(m)` → `string[]` of glyphs `👁` `⭐` `⚠`.

- [ ] **Step 1: Write the failing test**

Create `tests/schemas/models.ts`:

```ts
import { z } from "zod";

// Picker rows built by lib/models.js buildModelPicker — the merge of the
// authed /models/available list with the no-auth /models/catalog metadata.

export const PickerModelSchema = z.object({
  model_name: z.string().min(1),
  label: z.string(),
  vision: z.enum(["yes", "no", "unknown"]),
  free: z.boolean(),
  deprecated: z.union([z.literal(false), z.object({ successor: z.string().min(1) })]),
});

export const ModelPickerSchema = z.object({
  defaultModel: z.string(),
  models: z.array(PickerModelSchema),
});
```

Create `tests/models.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { buildModelPicker, modelBadge } from "../extension/lib/models.js";
import { ModelPickerSchema, PickerModelSchema } from "./schemas/models";

const AVAILABLE = [
  { model_name: "anthropic:claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { model_name: "openai:gpt-6", label: "" },
];
const CATALOG = [
  { model_name: "anthropic:claude-haiku-4-5", label: "Claude Haiku 4.5", supports_images: false },
  { model_name: "openai:gpt-6", label: "GPT-6", supports_images: true },
  { model_name: "vendor:free-1", label: "Free One", supports_images: true },
  { model_name: "vendor:legacy", label: "Legacy", supports_images: false },
];
const META = {
  default_chat_model_id: "openai:gpt-6",
  featured_model_ids: ["vendor:free-1"],
  featured_models_are_free: true,
  deprecation_map: { "vendor:legacy": "vendor:free-1" },
};

describe("buildModelPicker", () => {
  const picker = buildModelPicker(AVAILABLE, CATALOG, META);

  it("returns schema-valid output", () => {
    expect(ModelPickerSchema.safeParse(picker).success).toBe(true);
    for (const m of picker.models) {
      expect(PickerModelSchema.safeParse(m).success).toBe(true);
    }
  });

  it("keeps the available list as the spine, in order", () => {
    expect(picker.models.map((m) => m.model_name)).toEqual([
      "anthropic:claude-haiku-4-5",
      "openai:gpt-6",
      "vendor:free-1", // appended catalog-only free model
    ]);
  });

  it("joins catalog metadata: vision + label fallback + default", () => {
    expect(picker.defaultModel).toBe("openai:gpt-6");
    const haiku = picker.models.find((m) => m.model_name === "anthropic:claude-haiku-4-5")!;
    expect(haiku.vision).toBe("no");
    expect(picker.models.find((m) => m.model_name === "openai:gpt-6")!.label).toBe("GPT-6");
  });

  it("appends only catalog-only models that are free+featured", () => {
    expect(picker.models.some((m) => m.model_name === "vendor:legacy")).toBe(false);
    expect(picker.models.find((m) => m.model_name === "vendor:free-1")!.free).toBe(true);
  });

  it("maps deprecation to a successor", () => {
    const legacy = buildModelPicker([{ model_name: "vendor:legacy" }], CATALOG, META).models[0];
    expect(legacy.deprecated).toEqual({ successor: "vendor:free-1" });
  });

  it("degrades to a bare list when catalog/meta are missing", () => {
    const bare = buildModelPicker(AVAILABLE, null, {});
    expect(ModelPickerSchema.safeParse(bare).success).toBe(true);
    expect(bare.models).toHaveLength(2);
    expect(bare.models[0].vision).toBe("unknown");
  });
});

describe("modelBadge", () => {
  it("emits glyphs for vision, free, deprecated", () => {
    expect(modelBadge({ model_name: "m", label: "M", vision: "yes", free: true, deprecated: false })).toEqual(["👁", "⭐"]);
    expect(modelBadge({ model_name: "m", label: "M", vision: "no", free: false, deprecated: { successor: "x" } })).toEqual(["⚠"]);
    expect(modelBadge({ model_name: "m", label: "M", vision: "unknown", free: false, deprecated: false })).toEqual([]);
    expect(modelBadge(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/models.test.ts`
Expected: FAIL — cannot resolve `../extension/lib/models.js`.

- [ ] **Step 3: Write the implementation**

Create `extension/lib/models.js`:

```js
// Model picker — merge the authed available list (/models/available, the
// spine: what the API accepts) with the public catalog (/models/catalog,
// metadata: vision support, featured/free, deprecations). Pure logic; the
// background owns the network half (LIST_MODELS / GET_VISION_CATALOG).

import { findModelEntry, modelVisionSupport } from './vision.js';

function rowFromAvailable(m, cat, freeFeatured, featuredIds, deprecation) {
  const entry = findModelEntry(cat, m.model_name);
  return {
    model_name: m.model_name,
    label: m.label || (entry && entry.label) || m.model_name,
    vision: modelVisionSupport(entry),
    free: freeFeatured && featuredIds.has(m.model_name),
    deprecated: deprecation[m.model_name] ? { successor: deprecation[m.model_name] } : false,
  };
}

/**
 * Build picker rows. `available` order is preserved (it is the API's own
 * ordering). Catalog-only models are appended only when they are
 * featured+free — surfacing every catalog model would drown the list with
 * models the tenant may not be able to use.
 */
export function buildModelPicker(available, catalog, catalogMeta = {}) {
  const avail = Array.isArray(available) ? available.filter((m) => m && m.model_name) : [];
  const cat = Array.isArray(catalog) ? catalog : [];
  const featuredIds = new Set(Array.isArray(catalogMeta.featured_model_ids) ? catalogMeta.featured_model_ids : []);
  const freeFeatured = catalogMeta.featured_models_are_free === true;
  const deprecation = catalogMeta.deprecation_map || {};

  const seen = new Set();
  const models = avail.map((m) => {
    seen.add(m.model_name);
    return rowFromAvailable(m, cat, freeFeatured, featuredIds, deprecation);
  });

  for (const entry of cat) {
    if (!entry || !entry.model_name || seen.has(entry.model_name)) continue;
    if (!(freeFeatured && featuredIds.has(entry.model_name))) continue;
    seen.add(entry.model_name);
    models.push({
      model_name: entry.model_name,
      label: entry.label || entry.model_name,
      vision: modelVisionSupport(entry),
      free: true,
      deprecated: deprecation[entry.model_name] ? { successor: deprecation[entry.model_name] } : false,
    });
  }

  return { defaultModel: catalogMeta.default_chat_model_id || '', models };
}

/** Badge glyphs for an option row ('' labels never — glyphs only). */
export function modelBadge(m) {
  if (!m) return [];
  const badges = [];
  if (m.vision === 'yes') badges.push('👁');
  if (m.free) badges.push('⭐');
  if (m.deprecated) badges.push('⚠');
  return badges;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/models.test.ts`
Expected: PASS (all describes green).

- [ ] **Step 5: Commit**

```bash
git add extension/lib/models.js tests/schemas/models.ts tests/models.test.ts
git commit -m "feat(models): lib/models.js — merge available+catalog into picker rows with badges"
```

---

### Task 2: background — return catalog meta from `GET_VISION_CATALOG`

**Files:**
- Modify: `extension/background.js` (the `fetchModelCatalog` function + `catalogCache` declaration + the `GET_VISION_CATALOG` case in the message router, ~line 313)

**Interfaces:**
- Consumes: `catalogIsStale` from `lib/vision.js` (existing).
- Produces: `fetchModelCatalog(force)` still returns the models array (unchanged callers — the tier-3 vision gate at ~line 656 keeps working); new exported-on-worker `fetchCatalogMeta()` or the cache gains `meta`; `GET_VISION_CATALOG` response becomes `{ success: true, models, meta }` — `meta = { default_chat_model_id, featured_model_ids, featured_models_are_free, deprecation_map }` (empty-object fallback on failure).

- [ ] **Step 1: Write the failing test**

In `tests/integration/background-flow.test.ts` (the background-only integration file — verify the exact filename with `ls tests/integration/`; if background scenarios live elsewhere, add there):

```ts
it("GET_VISION_CATALOG returns meta alongside models", async () => {
  const resp = await chrome.runtime.sendMessage({ type: "GET_VISION_CATALOG" });
  expect(resp.success).toBe(true);
  expect(Array.isArray(resp.models)).toBe(true);
  expect(resp.meta).toBeDefined();
  expect(resp.meta).toHaveProperty("featured_models_are_free");
});
```

(Point the fetch mock at `/models/catalog` returning `{ models: [...], default_chat_model_id: "m1", featured_model_ids: ["m1"], featured_models_are_free: true, deprecation_map: {} }` — extend `tests/helpers/zo-fetch-mock.ts` if it doesn't already serve this URL; #25's tests will show the existing pattern.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/ -t "GET_VISION_CATALOG returns meta"`
Expected: FAIL — `resp.meta` undefined.

- [ ] **Step 3: Implement**

In `background.js`: extend `catalogCache` to `{ fetchedAt: 0, models: null, meta: {}, inFlight: null }`; inside `fetchModelCatalog`'s in-flight fetch, after `const data = await r.json()`, stash `catalogCache.meta = { default_chat_model_id: data.default_chat_model_id || '', featured_model_ids: data.featured_model_ids || [], featured_models_are_free: data.featured_models_are_free === true, deprecation_map: data.deprecation_map || {} }` while continuing to return `data.models || []` (callers unchanged). In the `GET_VISION_CATALOG` case, change the response to `sendResponse({ success: true, models, meta: catalogCache.meta })`.

- [ ] **Step 4: Run the test suite**

Run: `bun test tests/`
Expected: PASS — new test green, no regression (the vision gate reads `.models`, which is unchanged).

- [ ] **Step 5: Commit**

```bash
git add extension/background.js tests/helpers/zo-fetch-mock.ts tests/integration
git commit -m "feat(models): GET_VISION_CATALOG also returns catalog meta (featured/free/deprecation)"
```

---

### Task 3: sidepanel — per-chat override + badged options

**Files:**
- Modify: `extension/sidepanel.js` (the `#model-select` populate block near the `LIST_MODELS` send, ~line 1180; the change handler near ~line 420; every `modelName: config.selectedModel || undefined` payload site — lines ~1813, ~3430, ~3809, ~3837; `switchToConversation`)
- Modify: `extension/sidepanel.html` (option text is built in JS — no structural change; add a title tooltip on `#model-select`)

**Interfaces:**
- Consumes: `buildModelPicker` / `modelBadge` from `lib/models.js`; `GET_VISION_CATALOG` response from Task 2.
- Produces: conversation field `conv.modelName: string` (persisted via the existing `saveConversationById`); helper `activeModelName()` → `conv?.modelName || config.selectedModel || undefined`.

- [ ] **Step 1: Write the failing test**

Extend `tests/integration/extension-flow.test.ts` (the single sidepanel-instance file) with a scenario that mocks `/models/available` + `/models/catalog` (Task 2's mock URLs), then:

```ts
it("model select: badges render, selection is per-chat and rides ASK_ZO", async () => {
  const sel = panelDoc.getElementById("model-select") as HTMLSelectElement;
  await waitUntil(() => sel.options.length > 1);
  // badge glyphs live in the option text
  expect([...sel.options].some((o) => /👁|⭐|⚠/.test(o.textContent || ""))).toBe(true);

  const visionOpt = [...sel.options].find((o) => /👁/.test(o.textContent || ""));
  sel.value = visionOpt!.value;
  sel.dispatchEvent(new panelWindow.Event("change"));

  // persisted on the conversation
  const convos = await chrome.storage.local.get("cobrowse_convos");
  const conv = Object.values(convos.cobrowse_convos)[0] as any;
  expect(conv.modelName).toBe(visionOpt!.value);

  // rides the ASK_ZO fetch body
  await sendUserQuery(panelDoc, "hello there");
  const body = fetchMock.lastAskBody();
  expect(body.model_name).toBe(visionOpt!.value);

  // a NEW chat falls back to the global default (no override)
  panelDoc.getElementById("new-chat-btn")!.click();
  sel.value = "";
  const convos2 = await chrome.storage.local.get("cobrowse_convos");
  // new conversation has no modelName set
  const newest = Object.values(convos2.cobrowse_convos).find((c: any) => !c.modelName);
  expect(newest).toBeDefined();
});
```

(Adapt helper names — `sendUserQuery` / `fetchMock.lastAskBody()` — to whatever this file already uses; the file's existing send-flow scenarios show the exact helpers.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/extension-flow.test.ts -t "model select"`
Expected: FAIL — options have no badge text (today's populate loop writes bare labels), and `conv.modelName` is undefined.

- [ ] **Step 3: Implement**

In `sidepanel.js`:

1. Add `import { buildModelPicker, modelBadge } from './lib/models.js';` next to the existing lib imports.
2. Replace the populate block (the one that sends `LIST_MODELS` and loops `data.models`) with:

```js
const [modelsResp, catResp] = await Promise.all([
  chrome.runtime.sendMessage({ type: 'LIST_MODELS' }),
  chrome.runtime.sendMessage({ type: 'GET_VISION_CATALOG' }),
]);
const available = modelsResp && modelsResp.models ? modelsResp.models : [];
const picker = buildModelPicker(available, (catResp && catResp.models) || [], (catResp && catResp.meta) || {});
cachedModels = picker.models;
modelSelect.innerHTML = '<option value="">Default</option>';
for (const m of picker.models) {
  const opt = document.createElement('option');
  opt.value = m.model_name;
  const badges = modelBadge(m).join(' ');
  opt.textContent = badges ? `${badges} ${m.label}` : m.label;
  if (m.deprecated) opt.title = `Deprecated — successor: ${m.deprecated.successor}`;
  modelSelect.appendChild(opt);
}
modelSelect.value = activeModelName() || '';
```

3. Add the helper near `saveConversationById`:

```js
function activeModelName() {
  const conv = conversations[activeId];
  return (conv && conv.modelName) || config.selectedModel || '';
}
```

4. Change the select's change handler (today `config.selectedModel = modelSelect.value;`) to write the chat override and persist:

```js
const conv = conversations[activeId];
if (conv) {
  conv.modelName = modelSelect.value;
  await saveConversationById(activeId);
}
config.selectedModel = modelSelect.value; // keeps legacy global behavior when no conv
```

5. In `switchToConversation`, after restoring state, re-sync: `modelSelect.value = activeModelName() || '';`
6. Replace every `modelName: config.selectedModel || undefined` with `modelName: activeModelName() || undefined` (four payload sites; search the exact string).

- [ ] **Step 4: Run the integration suite**

Run: `bun test tests/integration/extension-flow.test.ts`
Expected: PASS — new scenario green, all existing panel scenarios unaffected.

- [ ] **Step 5: Commit**

```bash
git add extension/sidepanel.js extension/sidepanel.html tests/integration/extension-flow.test.ts
git commit -m "feat(models): per-chat model override + catalog badges in the sidepanel picker"
```

---

### Task 4: options page — catalog-first model list (no token needed)

**Files:**
- Modify: `extension/options.js` (the `loadModels`-style function around line 449 that fetches `https://api.zo.computer/models/available` directly)

**Interfaces:**
- Consumes: `GET_VISION_CATALOG` via `chrome.runtime.sendMessage` (respects the configured endpoint origin via background's `apiOrigin()`); `buildModelPicker`/`modelBadge` — options.js is a classic script, so import dynamically exactly like it already loads `lib/modes.js`/`lib/prompt.js` (`const { buildModelPicker, modelBadge } = await import(chrome.runtime.getURL('lib/models.js'))`).

- [ ] **Step 1: Implement (manual-verify page; covered by lib tests in Task 1)**

Replace the hardcoded fetch: with no token saved → `chrome.runtime.sendMessage({ type: 'GET_VISION_CATALOG' })` → populate from `buildModelPicker([], resp.models, resp.meta)` (catalog-only free/featured rows + a "Default model" option), status text "Public catalog — save a token to see your available models". With a token → keep the current authed list as the spine and merge catalog meta via `buildModelPicker(available, resp.models, resp.meta)`, same option-text rendering as Task 3 (shared snippet — extract a tiny `renderModelOptions(container, picker)` into the dynamically-imported module usage or duplicate the 8-line loop; options.js cannot import at top level).

- [ ] **Step 2: Verify by hand**

Run: load the extension (`bun run package` → drag zip into `chrome://extensions`, or use the e2e harness below), open options **before** setting a token → model list renders from the catalog; set a token + test connection → list refreshes to the authed merge.

- [ ] **Step 3: Extend the options e2e spec**

In `e2e/05-options.spec.ts`, add a test: fresh profile (no token) → open options → `#model` select is populated (`option` count > 1) and `#model-status` mentions the catalog. The mock server already fronts the Zo API origin used by `GET_VISION_CATALOG` — if it doesn't serve `/models/catalog`, add a static handler there (mirror `e2e/mock-zo/server.mjs`'s existing `/models/*` routes; check first).

- [ ] **Step 4: Run e2e**

Run: `bun run test:e2e -- e2e/05-options.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/options.js e2e/05-options.spec.ts e2e/mock-zo/server.mjs
git commit -m "feat(models): options page lists catalog models before token save"
```

---

### Task 5: e2e — picker renders + selection persists

**Files:**
- Create: `e2e/10-model-picker.spec.ts`

**Interfaces:**
- Consumes: `launchExtension` harness from `e2e/helpers/` (see `e2e/02-streaming.spec.ts` for the panel-open pattern).

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";

test("model picker shows badged options and persists a per-chat selection", async ({ page, browser }) => {
  const { panel } = await launchExtension({ page, browser }); // adapt to the local helper signature
  const sel = panel.locator("#model-select");
  await expect(sel).toBeVisible();
  await expect(sel.locator("option")).toHaveCountGreaterThan?.(1); // or use .count()
  const first = await sel.locator("option").nth(1).getAttribute("value");
  await sel.selectOption({ index: 1 });
  await panel.reload();
  await expect(sel).toHaveValue(first ?? "");
});
```

(Adapt to the real harness — `launchExtension` returns handles per the existing specs; the assertion is: option count > 1, selection survives a panel reload through `cobrowse_convos` persistence.)

- [ ] **Step 2: Run**

Run: `bun run test:e2e -- e2e/10-model-picker.spec.ts`
Expected: PASS.

- [ ] **Step 3: Full gates**

Run: `bun run verify && bun run test:e2e`
Expected: both green; update the test counts in `AGENTS.md`'s Tests section only if CI's count assertion requires it (it reads the suite output — counts change is informational).

- [ ] **Step 4: Commit**

```bash
git add e2e/10-model-picker.spec.ts
git commit -m "test(models): e2e — picker renders, selection persists across reload"
```
