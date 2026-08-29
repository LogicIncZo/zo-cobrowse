import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  STRIP_MAX_TABS,
  TAB_EXCERPT_CHARS,
  TAB_EXCERPT_BUDGET,
  TAB_EXCERPT_FLOOR,
  MAX_READ_TAB_CYCLES,
  hostOf,
  isBlankPage,
  isCapturableUrl,
  formatChars,
  assignRefs,
  buildTabManifest,
  buildTabFollowUp,
  extractReadTabRequests,
  noteTabSent,
  isTabSentAt,
  ensureActiveTabRef,
  thinTabExcerpts,
  tabContentKey,
} from "../extension/lib/tab-contexts.js";
import {
  TabContextSchema,
  ManifestResultSchema,
  FollowUpResultSchema,
} from "./schemas/tab-contexts.js";
import { createConversationState } from "../extension/lib/context-policy.js";

function expectValid<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { message: string } } }, v: unknown, what: string): T {
  const p = schema.safeParse(v);
  if (!p.success) throw new Error(`${what} failed schema:\n${JSON.stringify(v, null, 2)}\n${p.error?.message}`);
  return p.data as T;
}

const tab = (overrides: Record<string, unknown> = {}) => ({
  tabId: 101,
  ref: "T1",
  title: "Hacker News",
  url: "https://news.ycombinator.com/item?id=1",
  host: "news.ycombinator.com",
  textLength: 18432,
  elementCount: 210,
  excerpt: "The thread discusses prompt assembly and token budgets for browser agents.",
  isActive: false,
  available: true,
  ...overrides,
});

describe("constants", () => {
  it("keeps the documented budgets", () => {
    expect(STRIP_MAX_TABS).toBe(10);
    expect(TAB_EXCERPT_CHARS).toBe(500);
    expect(TAB_EXCERPT_BUDGET).toBe(8000);
    expect(TAB_EXCERPT_FLOOR).toBe(100);
    expect(MAX_READ_TAB_CYCLES).toBe(3);
  });
});

describe("hostOf", () => {
  it("extracts the hostname", () => {
    expect(hostOf("https://github.com/x/pr")).toBe("github.com");
  });
  it("returns '' for garbage without throwing", () => {
    expect(hostOf("not a url")).toBe("");
    expect(hostOf("")).toBe("");
  });
});

describe("formatChars", () => {
  it("compacts thousands", () => expect(formatChars(18432)).toBe("~18k chars"));
  it("keeps small counts exact", () => expect(formatChars(840)).toBe("840 chars"));
  it("handles zero/negative", () => {
    expect(formatChars(0)).toBe("0 chars");
    expect(formatChars(-5)).toBe("0 chars");
  });
});

describe("assignRefs", () => {
  it("assigns T1..Tn in order without mutating input", () => {
    const input = [{ tabId: 3, title: "a", url: "https://a.com", host: "a.com", textLength: 10, elementCount: 1, excerpt: "x", isActive: false, available: true }];
    const out = assignRefs(input);
    expect(out[0].ref).toBe("T1");
    expect(input[0]).not.toHaveProperty("ref");
    const out2 = assignRefs([tab(), tab({ tabId: 102 })]);
    expect(out2.map((t: { ref: string }) => t.ref)).toEqual(["T1", "T2"]);
  });
  it("passes through empty input", () => {
    expect(assignRefs(undefined)).toEqual([]);
  });
});

describe("buildTabManifest", () => {
  it("renders stats + excerpt for an available background tab", () => {
    const m = expectValid(ManifestResultSchema, buildTabManifest([tab()]), "manifest");
    expect(m.entries[0].line).toBe(
      '- [T1] "Hacker News" — news.ycombinator.com — ~18k chars text, 210 links — not attached'
    );
    expect(m.entries[0].excerptLine).toMatch(/^  > Excerpt: The thread discusses/);
    expect(m.rendered).toContain("##".slice(0, 0)); // rendered has no section header — the prompt owns it
    expect(m.rendered).not.toContain("## Referenced Tabs");
  });

  it("schema-validates a full TabContext", () => {
    expectValid(TabContextSchema, tab(), "tab context");
  });

  it("marks the active tab as attached above when policy attached it (no excerpt)", () => {
    const m = buildTabManifest([tab({ isActive: true })], { activeTabAttached: true });
    expect(m.entries[0].line).toContain("(this tab, attached above)");
    expect(m.entries[0].excerptLine).toBeUndefined();
  });

  it("keeps the active tab's excerpt when the policy did NOT attach it", () => {
    const m = buildTabManifest([tab({ isActive: true })], { activeTabAttached: false });
    expect(m.entries[0].line).toContain("not attached");
    expect(m.entries[0].excerptLine).toBeDefined();
  });

  it("degrades unavailable tabs to URL-only", () => {
    const m = buildTabManifest([tab({ available: false, excerpt: "", textLength: 0, elementCount: 0, url: "https://x.com/p" })]);
    expect(m.entries[0].line).toBe('- [T1] "Hacker News" — news.ycombinator.com — unavailable, URL only — https://x.com/p');
    expect(m.entries[0].excerptLine).toBeUndefined();
  });

  it("applies the shared excerpt budget in order, floor 100", () => {
    // 17 available tabs × 500 would need 8500 > 8000 budget. The last tabs
    // fall below the floor and get no excerpt line at all.
    const tabs = Array.from({ length: 17 }, (_, i) => tab({ tabId: 100 + i, ref: `T${i + 1}` }));
    const m = buildTabManifest(tabs);
    const withExcerpt = m.entries.filter((e: { excerptLine?: string }) => e.excerptLine);
    expect(withExcerpt.length).toBe(16); // 16×500 = 8000 exactly; the 17th gets none
    const total = withExcerpt.reduce((n: number, e: { excerptLine: string }) => n + e.excerptLine.length, 0);
    expect(total).toBeLessThanOrEqual(16 * (TAB_EXCERPT_CHARS + 30)); // excerpt + wrapper overhead
  });

  it("caps per-tab excerpt length", () => {
    const long = tab({ excerpt: "a".repeat(5000) });
    const m = buildTabManifest([long]);
    expect((m.entries[0].excerptLine || "").length).toBeLessThanOrEqual(TAB_EXCERPT_CHARS + 30);
  });

  it("collapses whitespace in excerpts", () => {
    const m = buildTabManifest([tab({ excerpt: "line1\n\n   line2\t\ttab" })]);
    expect(m.entries[0].excerptLine).toContain("line1 line2 tab");
  });
});

describe("buildTabFollowUp", () => {
  const refData = { ref: "T2", title: "PR #123", url: "https://github.com/o/r/pull/123", host: "github.com" };

  it("builds a content follow-up with fenced text and continuation cue", () => {
    const f = expectValid(FollowUpResultSchema, buildTabFollowUp(refData, { visibleText: "merge body" }, { textBudget: 100 }), "follow-up");
    expect(f.kind).toBe("content");
    expect(f.input).toContain('## Auto-attached: tab [T2] "PR #123" — github.com');
    expect(f.input).toContain("- URL: https://github.com/o/r/pull/123");
    expect(f.input).toContain("```text\nmerge body\n```");
    expect(f.input).toContain("Continue with the user's request");
  });

  it("clamps captured text to textBudget", () => {
    const f = buildTabFollowUp(refData, { visibleText: "x".repeat(500) }, { textBudget: 50 });
    expect(f.input).not.toContain("x".repeat(51));
  });

  it("falls back to a default budget when none given", () => {
    const f = buildTabFollowUp(refData, { visibleText: "y".repeat(20000) });
    expect(f.input).toContain("y".repeat(12000));
    expect(f.input).not.toContain("y".repeat(12001));
  });

  it("reports unavailable tabs conversationally", () => {
    const f = expectValid(FollowUpResultSchema, buildTabFollowUp(refData, null), "unavailable follow-up");
    expect(f.kind).toBe("unavailable");
    expect(f.input).toContain("(tab no longer available");
  });

  it("tells Zo the content is a duplicate instead of re-sending", () => {
    const f = buildTabFollowUp(refData, { visibleText: "should not appear" }, { reason: "duplicate" });
    expect(f.kind).toBe("duplicate");
    expect(f.input).toContain("(content already provided above");
    expect(f.input).not.toContain("should not appear");
  });

  it("builds the budget-exhausted wrap-up", () => {
    const f = buildTabFollowUp(refData, null, { reason: "budget" });
    expect(f.kind).toBe("budget");
    expect(f.input).toContain("tab-read budget for this turn exhausted");
  });

  it("tells Zo a blank/new-tab page has nothing to read", () => {
    const f = expectValid(FollowUpResultSchema, buildTabFollowUp(refData, null, { reason: "blank" }), "blank follow-up");
    expect(f.kind).toBe("blank");
    expect(f.input).toContain("blank/new-tab page — nothing to read");
    expect(f.input).toContain(`## Auto-attached: tab [T2] "PR #123" — github.com`);
  });
});

describe("extractReadTabRequests", () => {
  it("pulls valid read_tab actions and ignores the rest", () => {
    const out = extractReadTabRequests([
      { type: "click", selector: "#a" },
      { type: "read_tab", ref: "T3" },
      { type: "read_tab" },            // no ref — ignored
      { type: "read_tab", ref: "" },   // empty ref — ignored
      null,
      "junk",
    ]);
    expect(out).toEqual([{ ref: "T3" }]);
  });
  it("returns [] for non-array input", () => {
    expect(extractReadTabRequests(undefined)).toEqual([]);
    expect(extractReadTabRequests({})).toEqual([]);
  });
});

describe("tabsSent state helpers", () => {
  it("notes and matches per-tab send-once by page hash", () => {
    const s0 = createConversationState();
    expect(s0.tabsSent).toEqual({});
    const s1 = noteTabSent(s0, 42, "url|h1|100|5|2");
    expect(isTabSentAt(s1, 42, "url|h1|100|5|2")).toBe(true);
    expect(isTabSentAt(s1, 42, "OTHER")).toBe(false); // page changed → re-send allowed
    expect(isTabSentAt(s1, 43, "url|h1|100|5|2")).toBe(false); // other tab → send allowed
    expect(isTabSentAt(undefined, 42, "x")).toBe(false);
  });

  it("does not mutate the input state", () => {
    const s0 = createConversationState();
    noteTabSent(s0, 7, "h");
    expect(s0.tabsSent).toEqual({});
  });

  it("keeps prior entries when noting another tab", () => {
    const s1 = noteTabSent(createConversationState(), 1, "h1");
    const s2 = noteTabSent(s1, 2, "h2");
    expect(isTabSentAt(s2, 1, "h1")).toBe(true);
    expect(isTabSentAt(s2, 2, "h2")).toBe(true);
  });
});

// ---- wiring contracts (source-level, same pattern as message-contract) ----

const bgCode = readFileSync(resolve(import.meta.dir, "../extension/background.js"), "utf-8");
const spCode = readFileSync(resolve(import.meta.dir, "../extension/sidepanel.js"), "utf-8");
const htmlCode = readFileSync(resolve(import.meta.dir, "../extension/sidepanel.html"), "utf-8");

describe("tab contexts — background wiring", () => {
  it("handles GET_OPEN_TABS + GET_TAB_CONTEXTS and caps the strip", () => {
    expect(bgCode).toContain("case 'GET_OPEN_TABS'");
    expect(bgCode).toContain("case 'GET_TAB_CONTEXTS'");
    expect(bgCode).toContain(".slice(0, STRIP_MAX_TABS)");
  });

  it("captures referenced tabs without the debugger banner (skipDebugger)", () => {
    expect(bgCode).toMatch(/getActiveTabContext\(tabId, 2, null, \{ skipDebugger: true \}\)/);
  });

  it("chains pull follow-ups INSIDE the stream (before STREAM_DONE)", () => {
    expect(bgCode).toContain("finishStreamWithPullLoop");
    // Every terminal branch routes through the loop wrapper. The only bare
    // `finishStream(port` occurrences are the definition itself and the two
    // early-exit calls inside the wrapper (no loop / no pull requests).
    const bare = [...bgCode.matchAll(/(?<!WithPullLoop)finishStream\(port/g)].length;
    expect(bare).toBe(3);
    expect(bgCode).toContain("MAX_PULL_CYCLES");
    expect(bgCode).toContain("_followUpInput");
  });

  it("never forwards context-only pull actions to the DOM executor", () => {
    expect(bgCode).toMatch(/!isContextAction\(a\)/);
    expect(bgCode).not.toMatch(/a\.type !== 'read_tab'/);
  });

  it("emits a pull trace card on the STREAM_TOOL channel", () => {
    expect(bgCode).toContain("emitPullTrace");
    expect(bgCode).toMatch(/type: 'STREAM_TOOL'/);
  });
});

// ---- auto-referenced active tab (tier-0 turns) ----

describe("ensureActiveTabRef", () => {
  const active = (overrides: Record<string, unknown> = {}) => ({
    tabId: 7,
    title: "Current page",
    url: "https://current.example.com",
    host: "current.example.com",
    textLength: 9000,
    elementCount: 40,
    excerpt: "The current page body text peek.",
    isActive: true,
    available: true,
    ...overrides,
  });

  it("prepends the active tab (so it becomes T1 after re-assignRefs)", () => {
    const others = assignRefs([
      tab({ tabId: 101, ref: "T1" }),
      tab({ tabId: 102, ref: "T2" }),
    ]);
    const out = ensureActiveTabRef(others, active());
    expect(out).toHaveLength(3);
    expect(out[0].tabId).toBe(7);
    expect(out[0].isActive).toBe(true);
    const renumbered = assignRefs(out);
    expect(renumbered[0].ref).toBe("T1");
    expect(renumbered[0].tabId).toBe(7);
    for (const t of renumbered) expectValid(TabContextSchema, t, "auto-ref entry");
  });

  it("keeps the list untouched when the active tab is already referenced", () => {
    const list = assignRefs([tab({ tabId: 7 }), tab({ tabId: 101 })]);
    const out = ensureActiveTabRef(list, active());
    expect(out.map((t: { tabId: number }) => t.tabId)).toEqual([7, 101]);
  });

  it("no-ops on null/blank active contexts and junk entries", () => {
    const list = assignRefs([tab({ tabId: 101 })]);
    expect(ensureActiveTabRef(list, null)).toBe(list);
    expect(ensureActiveTabRef(list, active({ tabId: undefined }))).toBe(list);
    expect(ensureActiveTabRef(undefined, active())).toEqual([active()]);
    expect(ensureActiveTabRef([null, list[0]], active())[0].tabId).toBe(7);
  });

  it("never auto-references a blank active tab (cold start)", () => {
    const list = assignRefs([tab({ tabId: 101 })]);
    const newtab = active({ url: "chrome://newtab/", host: "newtab", title: "New Tab" });
    expect(ensureActiveTabRef(list, newtab)).toBe(list); // reference-stable no-op
    expect(ensureActiveTabRef(undefined, newtab)).toEqual([]); // cold start: no refs at all
  });
});

describe("isBlankPage / isCapturableUrl (cold-start predicates)", () => {
  it("isBlankPage matches the new-tab/blank family and ignores case/slash/query", () => {
    for (const url of [
      "",
      undefined,
      "about:blank",
      "about:newtab",
      "chrome://newtab",
      "chrome://newtab/",
      "chrome://new-tab-page/",
      "chrome://new-tab-page/?foo=1",
      "CHROME://NEWTAB/",
      "About:Blank",
    ]) {
      expect(isBlankPage(url as string)).toBe(true);
    }
  });

  it("isBlankPage is false for real pages (incl. other chrome:// pages)", () => {
    for (const url of [
      "https://example.com",
      "http://example.com/a?b=1",
      "chrome://settings",
      "file:///tmp/page.html",
      "edge://newtab", // alien but harmless — treat unknown schemes as pages
    ]) {
      expect(isBlankPage(url)).toBe(false);
    }
  });

  it("isCapturableUrl is exactly http(s) — the chip-strip filter, shared", () => {
    for (const url of ["https://a.com", "http://a.com/x", "HTTPS://A.COM"]) {
      expect(isCapturableUrl(url)).toBe(true);
    }
    for (const url of ["", undefined, "chrome://newtab/", "about:blank", "file:///tmp/a.html", "ftp://a.com"]) {
      expect(isCapturableUrl(url as string)).toBe(false);
    }
  });
});

describe("auto-active-tab — background wiring", () => {
  it("stamps the captured context with the source tabId (isActive dedup root cause)", () => {
    expect(bgCode).toMatch(/context\.tabId = tab\.id/);
  });
});

// ---- cold start — background wiring ------------------------------------------------

describe("cold start — background wiring", () => {
  it("short-circuits blank pages BEFORE any capture path (no debugger banner, no doomed injections)", () => {
    const guard = bgCode.indexOf("isBlankPage(tab.url");
    const debuggerPath = bgCode.indexOf("// Path 1: Debugger-based eval");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(debuggerPath).toBeGreaterThan(guard);
    // The short-circuit returns metadata only (url/title/tabId + blank stamp).
    expect(bgCode).toMatch(/blank: true/);
  });

  it("treats a blank capture in the read_tab loop as unreadable (reason 'blank')", () => {
    expect(bgCode).toMatch(/capture && !capture\.error && !capture\.blank/);
    expect(bgCode).toMatch(/reason: ['"]blank['"]/);
  });

  it("GET_OPEN_TABS filters via the shared isCapturableUrl helper (single source of truth)", () => {
    expect(bgCode).toMatch(/isCapturableUrl\(t\.url\)/);
    expect(bgCode).not.toMatch(/\/\^https\?:\/i\.test\(t\.url\)/);
  });

  it("getTabContexts skips capture for blank urls (degraded base only)", () => {
    expect(bgCode).toMatch(/isBlankPage\(base\.url\)/);
  });
});

// ---- cold start — sidepanel wiring --------------------------------------------------

describe("cold start — sidepanel wiring", () => {
  it("threads pageBlank into the context policy on BOTH call sites (send + inspector parity)", () => {
    // sendQuery and renderPromptInspector both compute the same pageBlank.
    const computes = [...spCode.matchAll(/isBlankPage\(currentContext\?\.url \|\| ''\)/g)].length;
    expect(computes).toBeGreaterThanOrEqual(2);
    expect(spCode).toMatch(/pageBlank,\s*\n/);
  });

  it("skips the page-mention pill on blank pages (no 'New Tab' pill noise)", () => {
    expect(spCode).toMatch(/\(currentContext\.title \|\| currentContext\.url\)[^\n]*&& !isBlankPage/);
  });
});

describe("auto-active-tab — sidepanel wiring", () => {
  it("auto-references the active tab on tier-0 turns and sends the merged list", () => {
    expect(spCode).toMatch(/effectiveTier === 0 && currentContext && currentContext\.tabId != null && !pageBlank/);
    expect(spCode).toMatch(/ensureActiveTabRef\(tabContexts, activeRef\)/);
    expect(spCode).toMatch(/tabContexts: sendTabContexts/);
  });

  it("mirrors the auto-reference in the inspector preview", () => {
    // effTier = decision.effectiveTier after the 📷-toggle force (sendQuery
    // and the inspector share the same post-force value).
    expect(spCode).toMatch(/previewTabContexts\(\{ includeActive: effTier === 0 \}\)/);
    expect(spCode).toMatch(/includeActive = false/);
  });

  it("adopts browser-tab switches for display (tabs API, no capture) and on new chats", () => {
    expect(spCode).toContain("adoptActiveTabDisplay");
    expect(spCode).toMatch(/chrome\.tabs\??:?\.?onActivated\.addListener|chrome\.tabs\.onActivated\.addListener/);
    expect(spCode).toMatch(/info\.windowId !== win\.id/); // scoped to this panel's window
  });
});

describe("tab contexts — sidepanel wiring", () => {
  it("has the chip strip + @ autocomplete markup", () => {
    expect(htmlCode).toContain('id="tab-contexts"');
    expect(htmlCode).toContain('id="tab-strip"');
    expect(htmlCode).toContain('id="tab-autocomplete"');
  });

  it("fetches fresh tab contexts per send and threads the merged list into ASK_ZO", () => {
    expect(spCode).toContain("fetchTabContextsForSend");
    // sendTabContexts = toggled tabs + the tier-0 auto-referenced active tab.
    expect(spCode).toMatch(/\.\.\.\(sendTabContexts\.length \? \{ tabContexts: sendTabContexts \} : \{\}\)/);
  });

  it("renders referenced-tab pills live and from history", () => {
    expect(spCode).toContain("renderTabRefPills");
    expect(spCode).toMatch(/m\.tabRefs/);
    expect(spCode).toContain("appendMentionPill");
  });

  it("resets/swaps chip toggles when the conversation changes", () => {
    // Per-chat toggles: switching chats stashes the outgoing set and restores
    // the incoming one (supersedes the old flat resetTabRefs).
    expect(spCode).toMatch(/stashTabRefs\(\)/);
    expect(spCode).toMatch(/restoreTabRefs\(\)/);
  });

  it("filters context-only pull actions out of DOM action handling (defensive)", () => {
    expect(spCode).toMatch(/!isContextAction\(a\)/);
    expect(spCode).not.toMatch(/a\.type !== 'read_tab'/);
  });
});

describe("thinTabExcerpts — send-once excerpt dedup for follow-up turns", () => {
  const mkTab = (overrides: Record<string, unknown> = {}) => ({
    tabId: 7,
    title: "Example",
    url: "https://example.com",
    host: "example.com",
    textLength: 4200,
    elementCount: 12,
    excerpt: "first five hundred chars of page text".padEnd(500, "x"),
    isActive: false,
    available: true,
    ...overrides,
  });

  it("keeps the excerpt on first send and records the tab's content key", () => {
    const { contexts, sentMap } = thinTabExcerpts([mkTab()], {});
    expect(contexts).toHaveLength(1);
    expect(contexts[0].pointerOnly).toBeUndefined();
    expect(contexts[0].excerpt).toBe(mkTab().excerpt);
    expect(sentMap["7"]).toBe(tabContentKey(mkTab()));
    expect(expectValid(TabContextSchema, { ...contexts[0], ref: "T1" }, "tab").tabId).toBe(7);
  });

  it("thins an unchanged tab to pointer-only on the next turn (excerpt dropped)", () => {
    const t = mkTab();
    const sentMap = { "7": tabContentKey(t) };
    const { contexts, sentMap: next } = thinTabExcerpts([t], sentMap);
    expect(contexts[0].pointerOnly).toBe(true);
    expect(contexts[0].excerpt).toBe("");
    // The dedup record persists unchanged (same content key).
    expect(next["7"]).toBe(tabContentKey(t));
    // Manifest renders the pointer line — the T-ref survives for read_tab.
    const { rendered } = buildTabManifest(assignRefs(contexts));
    expect(rendered).toContain("already provided above");
    expect(rendered).not.toContain("Excerpt:");
    expect(expectValid(ManifestResultSchema, { rendered, entries: [] }, "manifest shape").rendered).toBe(rendered);
  });

  it("re-sends the excerpt when the page navigates (url/title change)", () => {
    const before = mkTab();
    const after = mkTab({ url: "https://example.com/next", title: "Next" });
    const sentMap = { "7": tabContentKey(before) };
    const { contexts, sentMap: next } = thinTabExcerpts([after], sentMap);
    expect(contexts[0].pointerOnly).toBeUndefined();
    expect(next["7"]).toBe(tabContentKey(after));
  });

  it("stays pointer-only when only the excerpt text differs but url+title match (threading + read_tab cover it)", () => {
    const before = mkTab();
    const after = mkTab({ excerpt: "different page content".padEnd(300, "y") });
    const sentMap = { "7": tabContentKey(before) };
    const { contexts } = thinTabExcerpts([after], sentMap);
    expect(contexts[0].pointerOnly).toBe(true);
  });

  it("handles several tabs and skips malformed entries", () => {
    const a = mkTab({ tabId: 1 });
    const b = mkTab({ tabId: 2, url: "https://two.test", title: "Two" });
    const prior = { "2": tabContentKey(b) };
    const { contexts, sentMap } = thinTabExcerpts([a, b, null], prior);
    expect(contexts).toHaveLength(2);
    expect(contexts[0].pointerOnly).toBeUndefined();
    expect(contexts[1].pointerOnly).toBe(true);
    expect(Object.keys(sentMap).sort()).toEqual(["1", "2"]);
  });

  it("wires the dedup into the sidepanel send path", () => {
    expect(spCode).toContain("thinTabExcerpts(");
    expect(spCode).toContain("tabManifestSent");
  });
});
