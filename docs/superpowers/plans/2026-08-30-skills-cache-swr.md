# #73 Skills Cache + Truncation Loudness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `/` skills picker so it stops showing "Loading skills…" on every open (the MV3 service worker wipes the in-memory 5-min cache on restart) and stops silently dropping skills when the MCP listing is truncated.

**Architecture:** A small pure `createSessionCache()` factory (`extension/lib/sw-cache.js`) wraps one `chrome.storage.session` key with a memory fast-path, TTL, and in-flight dedup — replacing the plain in-memory objects in `background.js` for both the skills list and the vision model catalog. Truncation loudness: the skills bash command emits a `##SKILL_COUNT n` line first; `parseSkillsBundle` reports `{skills, totalFolders}`; a missing `__ZO_END__` marker becomes an honest error instead of a silent `[]`; the sidepanel shows "+N more" when folders were skipped.

**Tech Stack:** Bun test suite (`bun test tests/`), chrome-mock integration bus (`tests/helpers/chrome-mock.ts`), recording fetch mock (`tests/helpers/zo-fetch-mock.ts`), Zod schemas (`tests/schemas/pickers.ts`). No prompt changes — the prompt-evals cache is untouched by this issue.

**Issue:** [LogicIncZo/zo-cobrowse#73](https://github.com/LogicIncZo/zo-cobrowse/issues/73) · Slate: `docs/superpowers/specs/2026-08-30-0.2.6-slate-design.md` (Lane A, item 1)

## Global Constraints

- Branch: `fix/skills-cache-swr`, cut from `dev` (tip ≥ c678dd1). PR back to `dev`.
- Bun must be on PATH: `export PATH=/home/logic/.bun/bin:$PATH` (bare `bunx` can fail with `CouldntReadCurrentDirectory`).
- Commits AND pushes need the Mimosa bypass (known test-file false positives): `git -c core.hooksPath=/dev/null commit …` / `git -c core.hooksPath=/dev/null push …`.
- Explicit-path `git add` only (a concurrent agent shares this working tree); run `git status --porcelain` before every commit/PR.
- bun shares the module registry per process: every test import of an extension script needs a unique `?file=` cache-buster; keep ONE sidepanel instance per process (don't load sidepanel.js in mcp-flow tests).
- Run the full gate before the PR: `bun run verify` (tests + lint + transpile).
- Do NOT change any `lib/prompt.js` / mode-instruction text in this PR (would stale the prompt-evals cache for no reason).
- `dirCache` (60s, per-path `%` browser cache) is deliberately OUT of scope — cheap to refetch, high churn to persist.

## File Structure

| File | Role |
|------|------|
| Create: `extension/lib/sw-cache.js` | Pure session-cache factory (memory fast-path + `storage.session` backing, TTL, in-flight dedup). No `chrome.*` import — storage is injected. |
| Modify: `extension/background.js` | `listSkills()` (~line 1739) and `fetchModelCatalog()` (~line 1650) consume the factory; `LIST_SKILLS` handler (~line 338) adds `total` to the response; truncation becomes an honest error. |
| Modify: `extension/lib/pickers.js` | `skillsListCommand()` gains the `##SKILL_COUNT` line; `parseSkillsBundle()` returns `{skills, totalFolders}`. |
| Modify: `extension/sidepanel.js` | `ensureSkillsLoaded()` (~line 2546) stores `total`; `renderSkillPopup()` (~line 2567) appends the "+N more" note. |
| Modify: `tests/schemas/pickers.ts` | `ListSkillsResponseSchema` gains optional `total`. |
| Create: `tests/sw-cache.test.ts` | Unit tests for the factory (fake storage). |
| Modify: `tests/pickers.test.ts` | Parser tests for the new return shape + count line. |
| Modify: `tests/integration/mcp-flow.test.ts` | Cache-survives-SW-restart test; truncation-error test; `total` in fixture/asserts. |

---

### Task 1: `lib/sw-cache.js` — the session-backed cache factory

**Files:**
- Create: `extension/lib/sw-cache.js`
- Test: `tests/sw-cache.test.ts`

**Interfaces:**
- Produces: `createSessionCache({ storage, key, ttlMs, now? })` → `{ get(fetcher, force?), invalidate() }`. `storage` is anything shaped like `chrome.storage` (`get(key)` → object, `set(obj)`). A stored/returned `null`/`undefined` value is treated as a MISS (never cached) — this is what lets Task 5's catalog fetcher return null on failure without caching the failure.

- [ ] **Step 1: Write the failing test**

Create `tests/sw-cache.test.ts`:

```ts
// Unit: lib/sw-cache.js — the MV3 service worker gets killed after ~30s idle,
// which made plain in-memory TTL caches fiction (#73). This factory keeps a
// memory fast-path but backs it with one chrome.storage.session key so the
// cache survives worker restarts. Pure: storage is injected.
import { describe, it, expect } from "bun:test";
import { createSessionCache } from "../extension/lib/sw-cache.js";

function fakeStorage() {
  const bag: Record<string, any> = {};
  return {
    bag,
    async get(key: string) { return { [key]: bag[key] }; },
    async set(obj: Record<string, any>) { Object.assign(bag, obj); },
  };
}

describe("createSessionCache", () => {
  it("fetches on first get and writes the entry to session storage", async () => {
    const storage = fakeStorage();
    let calls = 0;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000 });
    const v = await cache.get(() => { calls++; return Promise.resolve(["a"]); });
    expect(v).toEqual(["a"]);
    expect(calls).toBe(1);
    expect(storage.bag.k).toEqual({ value: ["a"], fetchedAt: expect.any(Number) });
  });

  it("serves the memory fast-path within TTL without touching storage", async () => {
    const storage = fakeStorage();
    let calls = 0;
    let clock = 1000;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000, now: () => clock });
    await cache.get(() => { calls++; return Promise.resolve("v1"); });
    const v = await cache.get(() => { calls++; return Promise.resolve("v2"); });
    expect(v).toBe("v1");
    expect(calls).toBe(1);
  });

  it("hydrates from session storage in a FRESH instance (simulated SW restart)", async () => {
    const storage = fakeStorage();
    let calls = 0;
    const first = createSessionCache({ storage, key: "k", ttlMs: 60_000, now: () => 1000 });
    await first.get(() => Promise.resolve("survives"));
    // New worker: new module instance, same storage.
    const second = createSessionCache({ storage, key: "k", ttlMs: 60_000, now: () => 2000 });
    const v = await second.get(() => { calls++; return Promise.resolve("refetched"); });
    expect(v).toBe("survives");
    expect(calls).toBe(0);
  });

  it("expires entries past ttlMs and refetches", async () => {
    const storage = fakeStorage();
    let calls = 0;
    let clock = 1000;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000, now: () => clock });
    await cache.get(() => { calls++; return Promise.resolve("old"); });
    clock = 61_001;
    const v = await cache.get(() => { calls++; return Promise.resolve("new"); });
    expect(v).toBe("new");
    expect(calls).toBe(2);
  });

  it("force bypasses both memory and stored copies and overwrites them", async () => {
    const storage = fakeStorage();
    let calls = 0;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000, now: () => 1000 });
    await cache.get(() => Promise.resolve("stale"));
    const v = await cache.get(() => { calls++; return Promise.resolve("fresh"); }, true);
    expect(v).toBe("fresh");
    expect(calls).toBe(1);
    expect(storage.bag.k.value).toBe("fresh");
  });

  it("dedups concurrent fetches into one call", async () => {
    const storage = fakeStorage();
    let calls = 0;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000 });
    const [a, b] = await Promise.all([
      cache.get(() => { calls++; return new Promise((r) => setTimeout(() => r("x"), 5)); }),
      cache.get(() => { calls++; return new Promise((r) => setTimeout(() => r("y"), 5)); }),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe("x");
    expect(b).toBe("x");
  });

  it("treats null/undefined fetch results as a miss (never cached)", async () => {
    const storage = fakeStorage();
    let calls = 0;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000 });
    await cache.get(() => { calls++; return Promise.resolve(null); });
    await cache.get(() => { calls++; return Promise.resolve(null); });
    expect(calls).toBe(2); // failed fetches are retried, not cached
    expect(storage.bag.k).toBeUndefined();
  });

  it("survives a throwing storage backend (fetch still wins)", async () => {
    const storage = { get: () => Promise.reject(new Error("no session")), set: () => Promise.reject(new Error("no session")) };
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000 });
    const v = await cache.get(() => Promise.resolve("ok"));
    expect(v).toBe("ok");
  });

  it("a thrown fetcher error propagates and clears the in-flight slot", async () => {
    const storage = fakeStorage();
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000 });
    await expect(cache.get(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(cache.get(() => Promise.resolve("recovered"))).resolves.toBe("recovered");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/sw-cache.test.ts`
Expected: FAIL — `Cannot find module '../extension/lib/sw-cache.js'` (or equivalent import error).

- [ ] **Step 3: Write the implementation**

Create `extension/lib/sw-cache.js`:

```js
/**
 * MV3 service-worker cache that survives worker restarts (#73): a
 * memory-first wrapper over ONE chrome.storage.session key. The SW is killed
 * after ~30s idle — plain in-memory TTL caches (skills list, model catalog)
 * were wiped on every restart, so e.g. the `/` skills picker re-fetched and
 * showed "Loading skills…" on essentially every open.
 *
 * Pure: `storage` is injected (anything with get(key)/set(obj)), so this
 * unit-tests without chrome. `null`/`undefined` values are treated as a MISS
 * — a fetcher that fails by returning null is retried next call, never cached.
 *
 * @param {{
 *   storage: { get(key: string): Promise<object>, set(obj: object): Promise<void> },
 *   key: string,
 *   ttlMs: number,
 *   now?: () => number,
 * }} opts
 * @returns {{ get(fetcher: () => Promise<any>, force?: boolean): Promise<any>, invalidate(): void }}
 */
export function createSessionCache({ storage, key, ttlMs, now = Date.now }) {
  let mem = { value: undefined, fetchedAt: 0, inFlight: null };

  const fresh = (fetchedAt) => now() - fetchedAt < ttlMs;

  async function readStored() {
    try {
      const bag = await storage.get(key);
      const entry = bag && bag[key];
      if (entry && entry.value !== null && entry.value !== undefined && fresh(entry.fetchedAt)) {
        return entry;
      }
    } catch {
      // session storage unavailable (tests, hardened browsers) — fetch below
    }
    return null;
  }

  return {
    async get(fetcher, force = false) {
      if (!force && mem.value !== null && mem.value !== undefined && fresh(mem.fetchedAt)) {
        return mem.value;
      }
      if (mem.inFlight) return mem.inFlight;
      mem.inFlight = (async () => {
        if (!force) {
          const entry = await readStored();
          if (entry) {
            mem.value = entry.value;
            mem.fetchedAt = entry.fetchedAt;
            return entry.value;
          }
        }
        const value = await fetcher();
        mem.value = value;
        mem.fetchedAt = now();
        try {
          await storage.set({ [key]: { value, fetchedAt: mem.fetchedAt } });
        } catch {
          // cache write is best-effort
        }
        return value;
      })();
      try {
        return await mem.inFlight;
      } finally {
        mem.inFlight = null;
      }
    },
    invalidate() {
      mem = { value: undefined, fetchedAt: 0, inFlight: null };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/sw-cache.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git status --porcelain
git add extension/lib/sw-cache.js tests/sw-cache.test.ts
git -c core.hooksPath=/dev/null commit -m "feat(pickers): lib/sw-cache.js — session-backed cache factory that survives MV3 SW restarts (#73)"
```

---

### Task 2: `listSkills()` consumes the session cache

**Files:**
- Modify: `extension/background.js` (imports block near the top; `skillsListCache`/`listSkills` at ~lines 1736–1759)
- Test: `tests/integration/mcp-flow.test.ts`

**Interfaces:**
- Consumes: `createSessionCache` from Task 1.
- Produces: `listSkills(force)` — same signature and return shape as today (an array of skill entries; Task 3 changes the shape). The module-level `skillsListCache` object and `SKILLS_TTL_MS` constant are REMOVED.

- [ ] **Step 1: Write the failing test**

In `tests/integration/mcp-flow.test.ts`, add inside the existing `describe("LIST_SKILLS …")` block (after the "caches the list" test). The bus's `storage.session` (`makeStorageArea("session", …)`, chrome-mock.ts:374) is shared across module instances, so re-importing background.js under a NEW cache-buster simulates a worker restart while keeping the session store:

```ts
  it("cache survives a simulated SW restart — no new MCP round-trips after a background reload", async () => {
    // The pre-restart call already warmed the session cache in Task-2 wiring.
    const before = mcpRequests().length;
    // Reload background.js as a "new service worker instance" (fresh module
    // registry entry, same fake-chrome bus → same storage.session).
    await import("../../extension/background.js?file=mcp-flow-restart");
    await new Promise((r) => setTimeout(r, 25));
    const resp = await bus.runtime.sendMessage({ type: "LIST_SKILLS" });
    expect(resp.ok).toBe(true);
    expect(resp.skills.length).toBeGreaterThan(0);
    expect(mcpRequests().length).toBe(before);
  });
```

Note: place this test AFTER Task 3's fixture update if you land them together — the `before` count is only stable once the first test's fetch is the cache-filling one. If the existing "caches the list" test already ran, the session store is warm and `before` equals the post-restart count.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/integration/mcp-flow.test.ts`
Expected: the new test FAILS — the reloaded instance has an empty in-memory cache and issues fresh MCP round-trips (`mcpRequests().length` grows).

- [ ] **Step 3: Wire background.js**

In `extension/background.js`:

1. Add to the existing `lib/pickers.js` import block:

```js
import { createSessionCache } from './lib/sw-cache.js';
```

2. Replace the cache block (~lines 1736–1759) — delete `skillsListCache` and `SKILLS_TTL_MS`, keep `listSkills`:

```js
/**
 * #28 `/` picker source: the user's Zo skills, one bash round-trip that dumps
 * every SKILL.md head (name + description frontmatter). 5-min cache with
 * in-flight dedup, backed by chrome.storage.session so it SURVIVES MV3
 * service-worker restarts (#73 — the in-memory cache was wiped ~every open).
 */
const skillsCacheStore = createSessionCache({
  storage: chrome.storage,
  key: 'cobrowse_skills_list',
  ttlMs: 5 * 60 * 1000,
});

async function listSkills(force = false) {
  return skillsCacheStore.get(async () => {
    if (!config.zoAccessToken) throw new Error('Zo access token not configured.');
    const result = await mcpToolCall('bash', { cmd: skillsListCommand() });
    return parseSkillsBundle(toolText(result));
  }, force);
}
```

(The `LIST_SKILLS` handler at ~line 338 is unchanged in this task.)

- [ ] **Step 4: Run the tests**

Run: `bun test tests/integration/mcp-flow.test.ts && bun test tests/sw-cache.test.ts`
Expected: PASS — including the pre-existing "caches the list — a second call issues no new MCP round-trips" test (memory fast-path still works).

- [ ] **Step 5: Commit**

```bash
git status --porcelain
git add extension/background.js tests/integration/mcp-flow.test.ts
git -c core.hooksPath=/dev/null commit -m "fix(pickers): skills cache survives service-worker restarts — chrome.storage.session backing (#73)"
```

---

### Task 3: Truncation loudness — `##SKILL_COUNT`, report shape, honest error

**Files:**
- Modify: `extension/lib/pickers.js` (`skillsListCommand` ~line 69, `parseSkillsBundle` ~line 200)
- Modify: `extension/background.js` (`listSkills` fetcher from Task 2)
- Test: `tests/pickers.test.ts`, `tests/integration/mcp-flow.test.ts`

**Interfaces:**
- Consumes: existing `extractMarkedStdout` (returns `null` when either marker is missing — i.e. server-side truncation).
- Produces: `parseSkillsBundle(rawText)` → `{ skills: Array<{id,name,description}>, totalFolders: number | null }` (**breaking shape change** — both callers updated in this task); `skillsListCommand()` emits `##SKILL_COUNT n` as the FIRST line inside the markers (so tail truncation can't lose the count).

- [ ] **Step 1: Write the failing tests**

In `tests/pickers.test.ts`, update the existing `parseSkillsBundle` describe block: every `expect(parseSkillsBundle(x)).toEqual([…])` becomes `.toEqual({ skills: […], totalFolders: null })` for inputs without a count line. Add:

```ts
describe("parseSkillsBundle — ##SKILL_COUNT + truncation", () => {
  it("reads the count line and reports totalFolders next to the parsed list", () => {
    const raw = bundleText("##SKILL_COUNT 5\n##SKILL /home/workspace/Skills/a\n---\nname: A\n---\n");
    const { skills, totalFolders } = parseSkillsBundle(raw);
    expect(totalFolders).toBe(5);
    expect(skills.map((s) => s.name)).toEqual(["A"]);
  });

  it("count line survives even when the listing is cut short (marker missing → null is the caller's error)", () => {
    // Raw text truncated mid-payload: BEGIN present, END missing.
    const raw = "CmdResult(stdout='__ZO_BEGIN__\\n##SKILL_COUNT 9\\n##SKILL /home/workspace/Skills/a\\n---\\nname: A\\n---\\n', stderr='', returncode=0)";
    expect(parseSkillsBundle(raw)).toEqual({ skills: [], totalFolders: null });
  });

  it("totalFolders stays null when the count line is absent (backward-compat fixture shape)", () => {
    const raw = bundleText("##SKILL /home/workspace/Skills/a\n---\nname: A\n---\n");
    expect(parseSkillsBundle(raw).totalFolders).toBeNull();
  });
});
```

(`bundleText` = whatever helper the existing tests use to wrap stdout in the `CmdResult` + markers shape — reuse it; the pattern is `"CmdResult(stdout='__ZO_BEGIN__\\n…\\n__ZO_END__\\n', …)"`.)

In `tests/pickers.test.ts` (or the command describe block), add a command assertion:

```ts
it("skillsListCommand emits the count line first, inside the markers", () => {
  const cmd = skillsListCommand();
  const beginIdx = cmd.indexOf("__ZO_BEGIN__;");
  expect(cmd.indexOf("##SKILL_COUNT", beginIdx)).toBeGreaterThan(beginIdx);
  expect(cmd.indexOf("for d in", beginIdx)).toBeGreaterThan(cmd.indexOf("##SKILL_COUNT"));
  expect(cmd).toContain("wc -l");
});
```

In `tests/integration/mcp-flow.test.ts`:

1. Update `SKILLS_STDOUT` to carry a count of 3 (2 with SKILL.md heads → 1 "missing"):

```ts
const SKILLS_STDOUT = [
  "##SKILL_COUNT 3",
  "##SKILL /home/workspace/Skills/websh",
  // …(unchanged body)…
].join("\\n");
```

2. Extend the first LIST_SKILLS test's assertions:

```ts
expect(resp.total).toBe(3);
```

3. Add a truncation test:

```ts
  it("a truncated listing (missing END marker) is an honest error, not an empty list", async () => {
    const forceResp = await bus.runtime.sendMessage({ type: "LIST_SKILLS", force: true });
    expect(forceResp.ok).toBe(true); // warm cache still answers
    // Swap the handler to a truncated payload for the NEXT force fetch.
    truncated = true;
    const resp = await bus.runtime.sendMessage({ type: "LIST_SKILLS", force: true });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/truncat/i);
    truncated = false;
    const recovered = await bus.runtime.sendMessage({ type: "LIST_SKILLS", force: true });
    expect(recovered.ok).toBe(true);
  });
```

with a `let truncated = false;` flag next to the fixtures and the bash handler branch changed to:

```ts
if (cmd.includes("SKILL.md")) {
  const text = truncated
    ? "CmdResult(stdout='__ZO_BEGIN__\\n##SKILL_COUNT 3\\n##SKILL /home/workspace/Skills/websh\\n', stderr='', returncode=0)"
    : bashResult(SKILLS_STDOUT);
  return mcpOk(body.id, { isError: false, content: [{ type: "text", text }] });
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test tests/pickers.test.ts tests/integration/mcp-flow.test.ts`
Expected: FAIL — no `##SKILL_COUNT` in the command, `parseSkillsBundle` still returns a bare array, truncated payload parses to `ok:true, skills:[]`.

- [ ] **Step 3: Implement**

In `extension/lib/pickers.js` — `skillsListCommand`:

```js
/** One bash command that dumps every skill folder's SKILL.md head. The
 *  ##SKILL_COUNT line rides FIRST (inside the markers) so a server-side
 *  output truncation can still be detected by comparing counts (#73). */
export function skillsListCommand(skillsDir = SKILLS_DIR) {
  return [
    `echo ${STDOUT_BEGIN};`,
    `echo "##SKILL_COUNT $(ls -1d ${shellQuote(skillsDir)}/*/ 2>/dev/null | wc -l)";`,
    `for d in ${shellQuote(skillsDir)}/*/; do`,
    `f="\${d}SKILL.md";`,
    `if [ -f "$f" ]; then echo "##SKILL \${d%/}"; sed -n '1,${SKILL_HEAD_LINES}p' "$f"; echo; fi;`,
    `done;`,
    `echo ${STDOUT_END};`,
  ].join(' ');
}
```

In `extension/lib/pickers.js` — `parseSkillsBundle` (update the doc comment's `@returns` too):

```js
export function parseSkillsBundle(rawText) {
  const stdout = extractMarkedStdout(rawText);
  if (stdout == null) return { skills: [], totalFolders: null };
  const skills = [];
  let totalFolders = null;
  let current = null;
  let head = [];
  const flush = () => {
    if (!current) return;
    const fm = parseSkillFrontmatter(head.join('\n'));
    // Emit whenever the SKILL.md head carried ANY content — a folder whose
    // frontmatter is missing/unparseable is still a runnable skill (folder
    // name as the label). A folder with no head at all (marker only, e.g.
    // the head dump was cut short) is skipped.
    if (fm.name !== null || fm.description || head.some((l) => l.trim())) {
      skills.push({
        id: current,
        name: fm.name || current,
        description: fm.description.replace(/\s+/g, ' ').trim().slice(0, SKILL_DESC_MAX),
      });
    }
    current = null;
    head = [];
  };
  for (const line of stdout.split('\n')) {
    const cm = line.match(/^##SKILL_COUNT\s+(\d+)$/);
    if (cm) { totalFolders = parseInt(cm[1], 10); continue; }
    const m = line.match(/^##SKILL\s+(\/\S+)$/);
    if (m) {
      flush();
      current = m[1].split('/').pop() || m[1];
      continue;
    }
    if (current) head.push(line);
  }
  flush();
  return { skills, totalFolders };
}
```

In `extension/background.js` — `listSkills` fetcher (from Task 2) gains the honest error and the new shape:

```js
async function listSkills(force = false) {
  return skillsCacheStore.get(async () => {
    if (!config.zoAccessToken) throw new Error('Zo access token not configured.');
    const result = await mcpToolCall('bash', { cmd: skillsListCommand() });
    const raw = toolText(result);
    // A server-side output cap cuts the END marker off → extractMarkedStdout
    // nulls. Surface that honestly instead of caching a silent empty list (#73).
    if (extractMarkedStdout(raw) == null) {
      throw new Error('Skills listing came back truncated or unparseable — refresh to retry.');
    }
    return parseSkillsBundle(raw);
  }, force);
}
```

(`extractMarkedStdout` is already imported in background.js — it's used by `listWorkspaceDir`.)

In `extension/background.js` — the `LIST_SKILLS` handler (~line 338):

```js
case 'LIST_SKILLS': {
  // #28 `/` picker: enumerate the user's Zo skills (workspace Skills
  listSkills(!!request.force).then((r) => sendResponse({ ok: true, skills: r.skills, total: r.totalFolders ?? undefined }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
}
```

(Keep the handler's existing comment shape/structure — match what's there, only the response line changes. `total: undefined` keeps old JSON serializations clean when the count line is absent.)

- [ ] **Step 4: Run the tests**

Run: `bun test tests/pickers.test.ts tests/integration/mcp-flow.test.ts tests/sw-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status --porcelain
git add extension/lib/pickers.js extension/background.js tests/pickers.test.ts tests/integration/mcp-flow.test.ts
git -c core.hooksPath=/dev/null commit -m "feat(pickers): loud skill-list truncation — SKILL_COUNT line, {skills,totalFolders} report, honest error on cut listings (#73)"
```

---

### Task 4: Response schema + sidepanel "+N more" hint

**Files:**
- Modify: `tests/schemas/pickers.ts` (`ListSkillsResponseSchema`, ~line 25)
- Modify: `extension/sidepanel.js` (`ensureSkillsLoaded` ~line 2546, `renderSkillPopup` ~line 2567)
- Test: `tests/pickers.test.ts` (schema block, ~line 192)

**Interfaces:**
- Consumes: `LIST_SKILLS` response `{ok:true, skills, total?}` from Task 3.
- Produces: sidepanel `skillsCache` shape becomes `{ list, total, fetchedAt }`; `renderSkillPopup` appends a non-interactive note item when `total > list.length`.

- [ ] **Step 1: Write the failing test**

In `tests/pickers.test.ts` (the "LIST_SKILLS ok + error shapes validate" test at ~line 192):

```ts
it("LIST_SKILLS ok shape validates with and without the optional total", () => {
  expect(ListSkillsResponseSchema.safeParse({ ok: true, skills: [{ id: "a", name: "A", description: "" }], total: 5 }).success).toBe(true);
  expect(ListSkillsResponseSchema.safeParse({ ok: true, skills: [] }).success).toBe(true);
  expect(ListSkillsResponseSchema.safeParse({ ok: true, skills: [], total: -1 }).success).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/pickers.test.ts`
Expected: FAIL — schema has no `total` field, so the first parse is `false`.

- [ ] **Step 3: Update schema + sidepanel**

`tests/schemas/pickers.ts`:

```ts
export const ListSkillsResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    skills: z.array(SkillEntrySchema),
    /** Total skill FOLDERS seen by the bash listing (#73) — lets the UI say
     *  "+N more" when folders were skipped (no SKILL.md head / cut listing). */
    total: z.number().int().nonnegative().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
```

`extension/sidepanel.js` — `ensureSkillsLoaded` success branch:

```js
      const resp = await chrome.runtime.sendMessage({ type: 'LIST_SKILLS' });
      if (resp && resp.ok && Array.isArray(resp.skills)) {
        skillsCache = { list: resp.skills, total: resp.total ?? null, fetchedAt: Date.now() };
        return resp.skills;
      }
```

`extension/sidepanel.js` — `renderSkillPopup`, after the `items.slice(0, 8).forEach(…)` loop and before the popup's closing lines:

```js
  const hidden = skillsCache.total != null ? skillsCache.total - skillsCache.list.length : 0;
  if (hidden > 0) {
    popup.appendChild(pickerNoteItem(`+${hidden} more skill folder${hidden === 1 ? '' : 's'} not listed — no SKILL.md head found, or the listing was cut short. ⟳ refreshes.`));
  }
```

(Place it so the note renders for the full list; it does NOT need to react to the filter text — the count is about the workspace, not the query.)

- [ ] **Step 4: Run the tests**

Run: `bun test tests/pickers.test.ts tests/schemas 2>/dev/null; bun test tests/`
Expected: full suite PASS. (The schema change is additive/optional, so existing parses stay green.)

- [ ] **Step 5: Commit**

```bash
git status --porcelain
git add tests/schemas/pickers.ts extension/sidepanel.js tests/pickers.test.ts
git -c core.hooksPath=/dev/null commit -m "feat(sidepanel): '/ ' picker shows +N more when skill folders were skipped; total in LIST_SKILLS schema (#73)"
```

---

### Task 5: `fetchModelCatalog()` — same session-cache treatment

**Files:**
- Modify: `extension/background.js` (`catalogCache` ~line 226, `fetchModelCatalog` ~line 1650)

**Interfaces:**
- Consumes: `createSessionCache` from Task 1.
- Produces: `fetchModelCatalog(force)` — identical signature/behavior (models array, or `null` on hard failure, which is a MISS and refetched next call). The `catalogCache` global is removed; `CATALOG_TTL_MS` moves into the factory config. `lib/vision.js`'s `catalogIsStale` is untouched (still exported + unit-tested; if background no longer calls it, leave the import only if other code uses it — remove the import if unused).

- [ ] **Step 1: Refactor**

1. Near the `catalogCache` declaration (~line 224–226), replace:

```js
// Vision catalog cache (#25): /models/catalog is no-auth + cheap, but we
// don't want to block every tier-3 turn on a fetch. Backed by
// chrome.storage.session so it survives MV3 SW restarts (same #73 fix as
// the skills list). A failed fetch returns null = MISS = retried, never cached.
const catalogCacheStore = createSessionCache({
  storage: chrome.storage,
  key: 'cobrowse_catalog_cache',
  ttlMs: CATALOG_TTL_MS,
});
```

(Delete the old `let catalogCache = { models: null, fetchedAt: 0, inFlight: null };` line. `CATALOG_TTL_MS` keeps its existing value/definition.)

2. Rewrite `fetchModelCatalog` so the existing fetch body becomes the factory's fetcher — the fetcher must return the models array on success and `null` on failure (never throw; keep whatever try/catch the current body has):

```js
async function fetchModelCatalog(force = false) {
  return catalogCacheStore.get(async () => {
    try {
      const catalogUrl = `${apiOrigin()}/models/catalog`;
      const r = await fetch(catalogUrl);
      if (!r.ok) return null;
      const data = await r.json();
      // …keep the existing normalization/validation of `data` here verbatim,
      // returning the models array (or null if the shape is unusable)…
    } catch {
      return null;
    }
  }, force);
}
```

3. Remove any now-dead references to `catalogCache` elsewhere in the file (`grep -n catalogCache extension/background.js` must come back empty except the store).

- [ ] **Step 2: Run the suite**

Run: `bun test tests/`
Expected: PASS — no behavior change is intended; existing vision/extension-flow tests exercise `fetchModelCatalog` through `GET_VISION_CATALOG` and the vision gate.

- [ ] **Step 3: Commit**

```bash
git status --porcelain
git add extension/background.js
git -c core.hooksPath=/dev/null commit -m "refactor(vision): model catalog cache rides the session-backed SW cache (#73)"
```

---

### Task 6: Docs + PR

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Fixed`)
- Modify: `AGENTS.md` (the `extension/lib/` bullet list — one line for `sw-cache.js`)
- Modify: `BACKLOG.md` (0.2.6 Lane A — mark #73 shipped in the PR description step; the row-level annotation lands at merge)

- [ ] **Step 1: Docs**

`CHANGELOG.md` — under `[Unreleased]` → `### Fixed`:

```markdown
- **Skills picker (`/`) no longer re-fetches on every open** (#73): the skills cache now survives MV3 service-worker restarts (`chrome.storage.session` backing, `lib/sw-cache.js`); the same treatment applied to the vision model-catalog cache. Truncated workspace listings are now loud — a `##SKILL_COUNT` line lets the picker show "+N more skill folders not listed" and a cut listing surfaces an honest error instead of a silent empty list.
```

`AGENTS.md` — add to the `extension/lib/` paragraph, alphabetically near `pickers.js`:

```markdown
`sw-cache.js` (#73 — `createSessionCache()`: memory-fast-path + `chrome.storage.session` backing so background caches survive MV3 SW restarts; consumed by the skills list + model catalog),
```

- [ ] **Step 2: Full gate**

Run: `bun run verify`
Expected: PASS (tests + lint + transpile).

- [ ] **Step 3: PR**

```bash
git status --porcelain   # must be clean or show only intended files
git checkout -b fix/skills-cache-swr   # (cut at Task 1 start, before Step 1 of Task 1)
```

(The branch is created at the START of Task 1, not here — this step only opens the PR after the gate.)

```bash
git -c core.hooksPath=/dev/null push -u origin fix/skills-cache-swr
gh pr create --repo LogicIncZo/zo-cobrowse --base dev --head fix/skills-cache-swr \
  --title "fix: skills picker cache survives SW restarts + loud truncation (#73)" \
  --body "Closes #73. Lane A item 1 of the 0.2.6 slate (docs/superpowers/specs/2026-08-30-0.2.6-slate-design.md).

- lib/sw-cache.js: session-backed cache factory (memory fast-path + storage.session, TTL, in-flight dedup) — the MV3 SW wipe made the 5-min in-memory TTL fiction.
- listSkills() + fetchModelCatalog() consume it (keys cobrowse_skills_list / cobrowse_catalog_cache).
- Truncation loudness: ##SKILL_COUNT rides first in the bash listing; parseSkillsBundle → {skills,totalFolders}; missing END marker → honest error; sidepanel shows '+N more skill folders' + LIST_SKILLS schema gains optional total.
- dirCache (% browser, 60s) deliberately out of scope."
```

- [ ] **Step 4: Verify CI and note follow-ups**

Watch `gh pr checks --repo LogicIncZo/zo-cobrowse fix/skills-cache-swr --watch` (test + lint + package + e2e on the PR run). Comment on #73 with the manual verification recipe: `git pull`, ↻ reload at `chrome://extensions`, reopen the panel, press `/` twice ~1 min apart — second open must render the list instantly with no "Loading skills…" flash.

---

## Self-Review Notes

- **Spec coverage:** issue #73's two halves map to Task 2 (cache persistence) + Task 3/4 (incomplete-list loudness); the issue's "audit all SW-memory caches" line is covered by Task 5 (catalog) and the explicit out-of-scope note for `dirCache`.
- **Type consistency:** `parseSkillsBundle` → `{skills, totalFolders}` is applied to both callers (background `listSkills` fetcher, `LIST_SKILLS` handler) and all tests in the same task it changes. The sidepanel's `skillsCache` gains `total` only in Task 4, after the wire format carries it.
- **Ordering:** Task 2's restart test depends on the Task-3 fixture only for the `before`-count stability note — called out inline.
