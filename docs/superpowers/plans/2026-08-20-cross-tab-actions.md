# Cross-tab Actions (#10, actions half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zo can act on referenced tabs (T1…Tn) and manage tabs (`open_tab`/`close_tab`/`switch_tab`), with per-action routing, no focus stealing, and tab-routed parked actions.

**Architecture:** Refs stay the only cross-tab address (raw tabIds from the model are ignored). `lib/tab-contexts.js` gains `resolveActionTab`; `background.js#executeActions` resolves per action and routes `EXECUTE_ACTION` per target tab, executing the three tab verbs directly with `chrome.tabs.*`. The sidepanel records `tabId` on parked actions and renders a tab chip on cross-tab cards. Spec: `docs/superpowers/specs/2026-08-20-cross-tab-actions-design.md`. Builds on the 0.1.0 tab-contexts half; coordinate with the form-fill plan if both are in flight (both touch `executeActions`).

**Tech Stack:** Chrome MV3 tabs API, bun:test, Zod, fake-chrome tabs routing integration harness, Playwright e2e.

## Global Constraints

- Refs only — never trust a model-supplied numeric `tabId`.
- Background-tab execution never focuses the tab and never shows the debugger banner (`{skipDebugger:true}` path, established by the 0.1.0 background-capture work).
- Unknown ref ⇒ loud per-action failure, never a silent fallback to the active tab.
- The sender tab is never closed by `close_tab` unless explicitly ref'd.
- Pure ref algebra in `lib/tab-contexts.js`; `chrome.tabs.*` only in background.js.
- `bun run verify` green before every commit.

---

### Task 1: Schema — `tab` field + tab-management actions + `resolveActionTab`

**Files:**
- Modify: `tests/schemas/actions.ts` (`tab` on DOM actions; three new actions; union + `ACTION_TYPES`)
- Modify: `tests/schemas/tab-contexts.ts` (result schema for `resolveActionTab`)
- Modify: `extension/lib/tab-contexts.js` (new `resolveActionTab`)
- Test: `tests/tab-contexts.test.ts` (extend), `tests/actions-coverage.test.ts` (extend expectations — tab verbs are background-level)

**Interfaces:**
- Produces:
  - `tab: z.string().regex(/^T\d+$/).optional()` on `ClickAction`, `FillAction`, `FillFormAction`, `ExtractAction`, `ScrollAction` (and `navigate` gains it too — routed `chrome.tabs.update`).
  - `OpenTabAction { type:'open_tab', url: z.string().url(), background: z.boolean().optional() }`, `CloseTabAction { type:'close_tab', tab: z.string().regex(/^T\d+$/).optional() }`, `SwitchTabAction { type:'switch_tab', tab: z.string().regex(/^T\d+$/) }` in the union + `ACTION_TYPES`.
  - `resolveActionTab(action, tabContexts)` → `number|null` — matches `action.tab` against `tc.ref` entries (tab-context entries carry their source `tabId`).

- [ ] **Step 1: Write the failing tests**

In `tests/tab-contexts.test.ts`:

```ts
describe("resolveActionTab", () => {
  const ctxs = [
    { ref: "T1", tabId: 11, url: "https://a.example/", title: "A" },
    { ref: "T2", tabId: 22, url: "https://b.example/", title: "B" },
  ];
  it("resolves a ref to its tabId", () => {
    expect(resolveActionTab({ type: "click", selector: "#x", tab: "T2" }, ctxs)).toBe(22);
  });
  it("returns null when no tab field and for unknown refs", () => {
    expect(resolveActionTab({ type: "click", selector: "#x" }, ctxs)).toBeNull();
    expect(resolveActionTab({ type: "click", selector: "#x", tab: "T9" }, ctxs)).toBeNull();
    expect(resolveActionTab({ type: "click", selector: "#x", tab: "11" }, ctxs)).toBeNull(); // raw tabId ignored
  });
});
```

In `tests/schemas/actions.ts` consumers (the schema file is the contract — add validation cases in `tests/message-contract.test.ts` or wherever actions are round-tripped; minimum):

```ts
it("tab field must be a Tn ref", () => {
  expect(Action.safeParse({ type: "click", selector: "#x", tab: "T2" }).success).toBe(true);
  expect(Action.safeParse({ type: "click", selector: "#x", tab: 42 }).success).toBe(false);
  expect(Action.safeParse({ type: "click", selector: "#x", tab: "tab-2" }).success).toBe(false);
  expect(Action.safeParse({ type: "open_tab", url: "https://x.dev/" }).success).toBe(true);
  expect(Action.safeParse({ type: "open_tab", url: "not-a-url" }).success).toBe(false);
  expect(Action.safeParse({ type: "switch_tab", tab: "T1" }).success).toBe(true);
  expect(Action.safeParse({ type: "close_tab" }).success).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/tab-contexts.test.ts tests/message-contract.test.ts -t "resolveActionTab|tab field"`
Expected: FAIL — `resolveActionTab` not exported; `tab` rejected by the schemas.

- [ ] **Step 3: Implement**

Schema additions in `tests/schemas/actions.ts`:

```ts
const TabRef = z.string().regex(/^T\d+$/);

export const ClickAction = z.object({ type: z.literal("click"), selector: z.string().min(1), tab: TabRef.optional() });
// ...same optional tab on FillAction, FillFormAction, ExtractAction, ScrollAction, NavigateAction

export const OpenTabAction = z.object({
  type: z.literal("open_tab"),
  url: z.string().url(),
  background: z.boolean().optional(),
});
export const CloseTabAction = z.object({
  type: z.literal("close_tab"),
  tab: TabRef.optional(),
});
export const SwitchTabAction = z.object({
  type: z.literal("switch_tab"),
  tab: TabRef,
});
```

(Join the union; append `"open_tab"`, `"close_tab"`, `"switch_tab"` to `ACTION_TYPES`.)

In `extension/lib/tab-contexts.js`:

```js
/**
 * Resolve an action's "tab" ref (T1…Tn) to the source tabId. Returns null for
 * absent/unknown refs — callers fail loudly rather than falling back to the
 * active tab (a silent fallback would act on the wrong page). Raw numeric
 * tabIds are never accepted from the model.
 */
export function resolveActionTab(action, tabContexts) {
  if (!action || !action.tab) return null;
  const ctx = (tabContexts || []).find((t) => t && t.ref === action.tab);
  return ctx ? ctx.tabId : null;
}
```

Update `tests/actions-coverage.test.ts`: `open_tab`/`close_tab`/`switch_tab` are handled at the `executeActions` level in background.js — add them to `BACKGROUND_ABOVE_SWITCH`-style handling (assert `action.type === 'open_tab'` etc. appears in background source once Task 2 lands; keep the same PENDING-filter pattern the form-fill plan used, or implement Task 2 before un-skipping).

- [ ] **Step 4: Run + commit**

Run: `bun test tests/tab-contexts.test.ts tests/message-contract.test.ts tests/actions-coverage.test.ts`
Expected: PASS (with tab verbs pending in coverage if Task 2 hasn't landed).

```bash
git add tests/schemas/actions.ts tests/schemas/tab-contexts.ts extension/lib/tab-contexts.js tests/tab-contexts.test.ts tests/actions-coverage.test.ts
git commit -m "feat(cross-tab): tab refs on DOM actions + open/close/switch_tab schemas + resolveActionTab"
```

---

### Task 2: Background — per-action routing + tab verbs

**Files:**
- Modify: `extension/background.js` (`executeActions` ~line 1805 — routing loop; import `resolveActionTab` from `./lib/tab-contexts.js`; the `EXECUTE_ACTIONS` case needs the sidepanel's current `tabContexts` — see Interfaces)
- Test: `tests/integration/` (background-flow file)

**Interfaces:**
- Consumes: `resolveActionTab` (Task 1). `EXECUTE_ACTIONS` payload gains `tabContexts?: Array<{ref, tabId, ...}>` — the sidepanel already holds `sendTabContexts` when it sends `ASK_ZO`; it passes the same array on `EXECUTE_ACTIONS`. Absent `tabContexts` + an action with `tab` ⇒ that action fails with `unknown tab ref`.
- Produces: `executeActions(actions, tabId, tabContexts)` — per action: `open_tab` → `chrome.tabs.create({ url, active: action.background !== true })` result `{ok, type, tabId}`; `close_tab` → resolve ref → `chrome.tabs.remove` (guard: never `senderTabId`; omit `tab` ⇒ close the *current action target* only when it differs from the sender); `switch_tab` → `chrome.tabs.update(resolved, { active: true })` + `chrome.windows.update(winId, { focused: true })`; DOM actions route `EXECUTE_ACTION` to `resolveActionTab(action, tabContexts) ?? tabId`. A tab-routing failure pushes `{ok:false, error:'unknown tab ref …'}` and **continues** the loop (relaxed break: only non-tab errors break).

- [ ] **Step 1: Write the failing test**

```ts
it("routes actions to referenced tabs and manages tabs", async () => {
  const tabContexts = [
    { ref: "T1", tabId: senderTab, url: "https://a.test/", title: "A" },
    { ref: "T2", tabId: otherTab, url: "https://b.test/", title: "B" },
  ];
  const r = await chrome.runtime.sendMessage({
    type: "EXECUTE_ACTIONS",
    tabId: senderTab,
    tabContexts,
    actions: [
      { type: "fill", selector: "#q", value: "hello", tab: "T2" },   // background tab
      { type: "click", selector: "#go", tab: "T1" },                 // sender tab
      { type: "switch_tab", tab: "T2" },
      { type: "open_tab", url: "https://c.test/", background: true },
      { type: "click", selector: "#x", tab: "T9" },                  // unknown ref
    ],
  });
  expect(r.results[0].ok).toBe(true);
  expect((otherPageDoc.querySelector("#q") as HTMLInputElement).value).toBe("hello");
  expect(otherTabFocused).toBe(true);          // switch_tab focused T2's tab
  expect(createdTabUrl).toBe("https://c.test/");
  expect(r.results[4].ok).toBe(false);          // unknown ref — but the batch continued
  expect(r.results[4].error).toMatch(/unknown tab ref T9/);
});
```

(The fake-chrome mock's tabs routing already supports multi-tab `sendMessage` targeting — `createTabTarget` in `tests/helpers/chrome-mock.ts`.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/integration -t "routes actions to referenced tabs"`
Expected: FAIL — `fill` landed on the sender tab (no routing).

- [ ] **Step 3: Implement**

Rewrite the routing inside `executeActions` (keep Path 1/2/3 execution untouched — only the target and the loop semantics change):

```js
async function executeActions(actions, tabId, tabContexts = []) {
  if (!tabId) { /* existing active-tab resolution */ }
  const results = [];
  let created = [];
  for (const action of actions) {
    if (action.type === 'navigate') {
      const target = resolveActionTab(action, tabContexts) ?? tabId;
      await chrome.tabs.update(target, { url: action.url });
      results.push({ ok: true, type: 'navigate' });
      continue;
    }
    if (action.type === 'done') { results.push({ ok: true, type: 'done', response: action.response }); continue; }
    if (action.type === 'open_tab') {
      const tab = await chrome.tabs.create({ url: action.url, active: action.background !== true });
      created.push(tab.id);
      results.push({ ok: true, type: 'open_tab', tabId: tab.id });
      continue;
    }
    if (action.type === 'close_tab') {
      const target = (action.tab ? resolveActionTab(action, tabContexts) : tabId);
      if (target == null || target === tabId && !action.tab) { results.push({ ok: false, type: 'close_tab', error: 'refusing to close the sender tab' }); continue; }
      await chrome.tabs.remove(target);
      results.push({ ok: true, type: 'close_tab' });
      continue;
    }
    if (action.type === 'switch_tab') {
      const target = resolveActionTab(action, tabContexts);
      if (target == null) { results.push({ ok: false, type: 'switch_tab', error: `unknown tab ref ${action.tab}` }); continue; }
      const tab = await chrome.tabs.update(target, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      results.push({ ok: true, type: 'switch_tab' });
      continue;
    }

    const target = resolveActionTab(action, tabContexts);
    if (action.tab && target == null) {
      results.push({ ok: false, type: action.type, error: `unknown tab ref ${action.tab}` });
      continue; // relaxed break: a dead tab must not kill actions on live tabs
    }
    const routeTab = target ?? tabId;
    // ...existing Path 1 (debugger eval — skip when routeTab !== the active tab,
    //     keeping the banner-free discipline) / Path 2 (chrome.tabs.sendMessage
    //     to routeTab) / Path 3 (executeScript target routeTab)...
    if (!result?.ok && !result?.tabError) { /* existing break on real failures */ }
  }
  // ...existing allOk fold...
}
```

(Keep the existing `sleep(500)` cadence and result fold; the only semantic changes are the per-action `routeTab`, the three verbs, the unknown-ref continue, and skipping the debugger path for non-active tabs.)

Update the `EXECUTE_ACTIONS` case to pass `request.tabContexts || []` through.

- [ ] **Step 4: Run + commit**

Run: `bun test tests/integration tests/actions-coverage.test.ts`
Expected: PASS (un-skip tab verbs in the coverage test here).

```bash
git add extension/background.js tests/integration tests/actions-coverage.test.ts
git commit -m "feat(cross-tab): per-action tab routing + open/close/switch_tab verbs in executeActions"
```

---

### Task 3: Sidepanel — tabContexts on EXECUTE_ACTIONS, tab chips, parked-action routing

**Files:**
- Modify: `extension/sidepanel.js` (EXECUTE_ACTIONS send sites — add `tabContexts: sendTabContexts`; parked-actions store/restore — `restorePendingActionsFor` + wherever `conv.pendingActions` is written; action-card renderer — tab chip)
- Test: `tests/integration/extension-flow.test.ts`

**Interfaces:**
- Consumes: routing from Task 2.
- Produces: parked entries `{ action, tabId?, ref? }`; `restorePendingActionsFor` sends `EXECUTE_ACTIONS { actions, tabContexts: currentStripContexts, tabId }` — an action whose recorded tab is dead re-parks with a note; timeline cards for actions with `tab` show a `⟶ Tn · host` chip (host from the strip contexts).

- [ ] **Step 1: Write the failing test**

```ts
it("cross-tab pendingActions restore to their recorded tabs", async () => {
  // backgrounded chat parks an action carrying tab T2; user switches back;
  // restore routes it to T2's tab (still open) and executes there
  const before = await readConversation(parkedChatId);
  expect(before.pendingActions[0].tabId).toBe(otherTab);
  await switchToConversation(panelDoc, parkedChatId);
  await waitUntil(() => (otherPageDoc.querySelector("#q") as HTMLInputElement)?.value === "routed");
  // chip rendered on the card
  expect(panelDoc.querySelector(".action-card .tab-chip")?.textContent).toMatch(/T2/);
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (parked actions have no `tabId`; no `.tab-chip`).

- [ ] **Step 3: Implement**

1. When parking stream-finished actions (the chat-tabs pendingActions path), record per action: `tabId: resolveActionTab(action, sendTabContexts) ?? activeWebTabId, ref: action.tab || null` (import `resolveActionTab` — sidepanel already imports from `lib/tab-contexts.js`).
2. `restorePendingActionsFor(conv)`: build `actions` from parked entries; send `EXECUTE_ACTIONS { actions, tabContexts: currentStrip(), tabId: parked[0]?.tabId ?? activeTab }`. If the response shows an unknown-ref/tab-closed error for a parked entry, re-park that entry alone and surface an assistant note ("a pending action's tab is closed — reopen it and try again").
3. Action-card renderer: when `action.tab` exists, prepend `<span class="tab-chip">⟶ ${action.tab} · ${host}</span>` (host from the strip contexts map; fall back to the bare ref).

- [ ] **Step 4: Run + commit**

Run: `bun test tests/integration/extension-flow.test.ts`
Expected: PASS.

```bash
git add extension/sidepanel.js tests/integration/extension-flow.test.ts
git commit -m "feat(cross-tab): tab-routed pendingActions + tab chips on action cards"
```

---

### Task 4: Prompt — teach Zo the tab verbs

**Files:**
- Modify: `extension/lib/modes.js` (`ACTION_SCHEMA_COMPACT`)
- Test: `tests/modes.test.ts`

- [ ] **Step 1: Failing assertion**

```ts
it("action schema documents tab targeting + tab verbs", () => {
  expect(ACTION_SCHEMA_COMPACT).toContain('open_tab{url,background?}');
  expect(ACTION_SCHEMA_COMPACT).toContain('close_tab{tab?}');
  expect(ACTION_SCHEMA_COMPACT).toContain('switch_tab{tab}');
  expect(ACTION_SCHEMA_COMPACT).toMatch(/"tab":"Tn"/);
});
```

- [ ] **Step 2: FAIL run** → `bun test tests/modes.test.ts -t "tab targeting"`.

- [ ] **Step 3: Implement** — append to `ACTION_SCHEMA_COMPACT` (after the `get_form` clause, before the sensitive-form sentence from the form-fill plan if present):

```js
' Actions may set "tab":"Tn" to target a referenced tab (default: current). ' +
'Tab management: open_tab{url,background?} | close_tab{tab?} | switch_tab{tab}.'
```

- [ ] **Step 4: PASS run + commit**

Run: `bun test tests/modes.test.ts tests/prompt.test.ts && git add extension/lib/modes.js tests/modes.test.ts && git commit -m "feat(cross-tab): prompt documents tab targeting + tab-management verbs"`

---

### Task 5: e2e — cross-tab scenario

**Files:**
- Modify: `e2e/mock-zo/server.mjs` (scenario `cross-tab` — SSE actions `[{"type":"fill","selector":"#q","value":"from-t2","tab":"T2"},{"type":"switch_tab","tab":"T2"},{"type":"done","response":"done"}]`)
- Create: `e2e/12-cross-tab.spec.ts`

- [ ] **Step 1: Spec** — launch with two web tabs on the links fixture; reference both via chips (`@` autocomplete or chip strip — see `e2e/09-open-all.spec.ts` for chip mechanics); send the keyed query; assert the fill landed on the background tab's DOM **without** that tab being brought to front first (check `activeTabId` between actions if the harness exposes it, else assert final focus == T2 only after `switch_tab`).

```ts
test("cross-tab fill routes to the referenced tab without focusing it first", async () => {
  const { panel, tabs } = await launchExtension(/* two fixture tabs, T1 active */);
  await referenceTabs(panel, [1, 2]); // chip both — adapt to the harness helpers in 09-open-all.spec.ts
  await panel.locator("#chat-input").fill("run the cross-tab step");
  await panel.locator("#send-btn").click();
  await expect(panel.locator(".action-card .tab-chip")).toContainText("T2");
  const val = await tabs[1].locator("#q").inputValue();
  expect(val).toBe("from-t2");
});
```

- [ ] **Step 2: Full gates + commit**

Run: `bun run test:e2e -- e2e/12-cross-tab.spec.ts && bun run verify && bun run test:e2e`
Expected: green.

```bash
git add e2e/mock-zo/server.mjs e2e/12-cross-tab.spec.ts
git commit -m "test(cross-tab): e2e — referenced-tab fill without focus steal, switch_tab lands last"
```
