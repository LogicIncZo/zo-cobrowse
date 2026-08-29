import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  MAX_OPEN_TABS,
  TITLE_MAX,
  createTabsState,
  openChatTab,
  closeChatTab,
  activateChatTab,
  pruneChatTabs,
  tabTitleFor,
  renameConversation,
  searchConversations,
} from "../extension/lib/chat-tabs.js";
import {
  TabsStateSchema,
  ChatSummaryArray,
  RenameResultSchema,
  ConversationSchema,
} from "./schemas/chat-tabs.js";

function expectValid<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { message: string } } }, v: unknown, what: string): T {
  const p = schema.safeParse(v);
  if (!p.success) throw new Error(`${what} failed schema:\n${JSON.stringify(v, null, 2)}\n${p.error?.message}`);
  return p.data as T;
}

const conv = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Chat ${id}`,
  createdAt: 1000,
  updatedAt: 1000,
  messages: [{ role: "user", text: `hello from ${id}`, timestamp: 1000 }],
  ...overrides,
});

describe("constants", () => {
  it("keeps the documented knobs", () => {
    expect(MAX_OPEN_TABS).toBe(8);
    expect(TITLE_MAX).toBe(60);
  });
});

describe("createTabsState", () => {
  it("starts empty with a null activeId", () => {
    expectValid(TabsStateSchema, createTabsState(), "pristine state");
    expect(createTabsState()).toEqual({ openIds: [], activeId: null });
  });
});

describe("openChatTab", () => {
  it("opens + activates and is idempotent", () => {
    const s1 = openChatTab(createTabsState(), "a");
    expectValid(TabsStateSchema, s1, "opened state");
    expect(s1.openIds).toEqual(["a"]);
    expect(s1.activeId).toBe("a");
    const s2 = openChatTab(s1, "a");
    expect(s2.openIds).toEqual(["a"]);
    expect(s2.activeId).toBe("a");
  });

  it("keeps existing position when re-focusing an open tab", () => {
    let s = createTabsState();
    for (const id of ["a", "b", "c"]) s = openChatTab(s, id);
    expect(s.openIds).toEqual(["a", "b", "c"]);
    s = openChatTab(s, "a");
    expect(s.openIds).toEqual(["a", "b", "c"]);
    expect(s.activeId).toBe("a");
  });

  it("evicts the oldest-position non-active tab at the cap", () => {
    let s = createTabsState();
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) s = openChatTab(s, id);
    // Overflow: the newly-opened 'i' is active, so the oldest-position
    // non-active tab ('a') is evicted — like a browser, focus never reorders.
    s = openChatTab(s, "i");
    expect(s.openIds).toEqual(["b", "c", "d", "e", "f", "g", "h", "i"]);
    expect(s.activeId).toBe("i");
  });

  it("never evicts the active tab (tiny cap)", () => {
    let s = openChatTab(createTabsState(), "a", { maxOpen: 1 });
    s = openChatTab(s, "b", { maxOpen: 1 });
    expect(s.openIds).toEqual(["b"]);
    expect(s.activeId).toBe("b");
  });

  it("ignores blank ids", () => {
    const s = openChatTab(createTabsState(), "  ");
    expect(s.openIds).toEqual([]);
    expect(s.activeId).toBeNull();
  });
});

describe("closeChatTab", () => {
  it("no-ops on the last open tab — at least one stays open", () => {
    const s = openChatTab(createTabsState(), "a");
    const c = closeChatTab(s, "a");
    expect(c.openIds).toEqual(["a"]);
    expect(c.activeId).toBe("a");
  });

  it("no-ops on ids that are not open", () => {
    let s = createTabsState();
    for (const id of ["a", "b"]) s = openChatTab(s, id);
    const c = closeChatTab(s, "zzz");
    expect(c.openIds).toEqual(["a", "b"]);
  });

  it("closing the active middle tab activates the right neighbor", () => {
    let s = createTabsState();
    for (const id of ["a", "b", "c"]) s = openChatTab(s, id);
    const c = closeChatTab(s, "b");
    expect(c.openIds).toEqual(["a", "c"]);
    expect(c.activeId).toBe("c");
  });

  it("closing the active tail activates the previous tab", () => {
    let s = createTabsState();
    for (const id of ["a", "b", "c"]) s = openChatTab(s, id);
    const c = closeChatTab(s, "c");
    expect(c.openIds).toEqual(["a", "b"]);
    expect(c.activeId).toBe("b");
  });

  it("closing a background tab keeps the active one", () => {
    let s = createTabsState();
    for (const id of ["a", "b", "c"]) s = openChatTab(s, id);
    const c = closeChatTab(s, "a");
    expect(c.openIds).toEqual(["b", "c"]);
    expect(c.activeId).toBe("c");
  });
});

describe("activateChatTab", () => {
  it("activates an open tab and copies the state", () => {
    let s = createTabsState();
    for (const id of ["a", "b"]) s = openChatTab(s, id);
    const a = activateChatTab(s, "a");
    expect(a.activeId).toBe("a");
    expect(s.activeId).toBe("b"); // original untouched
  });

  it("no-ops on unknown ids", () => {
    const s = openChatTab(createTabsState(), "a");
    expect(activateChatTab(s, "zzz").activeId).toBe("a");
  });
});

describe("pruneChatTabs", () => {
  it("drops tabs whose conversations were deleted", () => {
    let s = createTabsState();
    for (const id of ["a", "b", "c"]) s = openChatTab(s, id);
    const p = pruneChatTabs(s, ["a", "c"]);
    expect(p.openIds).toEqual(["a", "c"]);
  });

  it("re-activates a survivor when the active tab was pruned", () => {
    let s = createTabsState();
    for (const id of ["a", "b", "c"]) s = openChatTab(s, id); // active: c
    const p = pruneChatTabs(s, ["a", "b"]);
    expect(p.openIds).toEqual(["a", "b"]);
    expect(p.activeId).toBe("a");
  });

  it("keeps the active id when it survives", () => {
    let s = createTabsState();
    for (const id of ["a", "b"]) s = openChatTab(s, id);
    const p = pruneChatTabs(s, ["b", "a"]);
    expect(p.activeId).toBe("b");
  });
});

describe("tabTitleFor", () => {
  it("caps long titles at TITLE_MAX", () => {
    expect(tabTitleFor(conv("a", { title: "x".repeat(80) })).length).toBe(TITLE_MAX);
  });

  it("falls back to New Chat and never throws", () => {
    expect(tabTitleFor(conv("a", { title: "   " }))).toBe("New Chat");
    expect(tabTitleFor(null)).toBe("New Chat");
  });
});

describe("renameConversation", () => {
  const map = { a: conv("a"), b: conv("b") };

  it("trims, caps, and returns a new map without mutating the original", () => {
    const r = expectValid(RenameResultSchema, renameConversation(map, "a", "  Research notes  "), "rename result");
    expect(r.changed).toBe(true);
    expect(r.convos.a.title).toBe("Research notes");
    expect(map.a.title).toBe("Chat a"); // original untouched
  });

  it("caps at TITLE_MAX", () => {
    const r = renameConversation(map, "a", "y".repeat(80));
    expect(r.convos.a.title.length).toBe(TITLE_MAX);
  });

  it("no-ops on empty/whitespace titles", () => {
    expect(renameConversation(map, "a", "   ").changed).toBe(false);
    expect(renameConversation(map, "a", "").changed).toBe(false);
  });

  it("no-ops on unknown ids and unchanged titles", () => {
    expect(renameConversation(map, "zzz", "new").changed).toBe(false);
    expect(renameConversation(map, "a", "Chat a").changed).toBe(false);
  });

  it("does not bump updatedAt (rename must not reorder history)", () => {
    const r = renameConversation(map, "a", "new title");
    expect(r.convos.a.updatedAt).toBe(map.a.updatedAt);
  });
});

describe("searchConversations", () => {
  const map = {
    a: conv("a", { title: "DuckDB research", updatedAt: 3000 }),
    b: conv("b", { title: "New Chat", updatedAt: 2000, messages: [{ role: "user", text: "find the cheapest flight to Lisbon", timestamp: 1 }] }),
    c: conv("c", { title: "Grocery list", updatedAt: 1000 }),
  };

  it("empty query returns everything, updatedAt desc, schema-valid", () => {
    const all = expectValid(ChatSummaryArray, searchConversations(map, ""), "summaries");
    expect(all.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(all[0].isActive).toBe(false);
  });

  it("flags the active conversation", () => {
    const all = searchConversations(map, "", { activeId: "b" });
    expect(all.find((s) => s.id === "b")!.isActive).toBe(true);
  });

  it("matches titles case-insensitively", () => {
    expect(searchConversations(map, "DUCK").map((s) => s.id)).toEqual(["a"]);
  });

  it("matches message text, not just titles", () => {
    expect(searchConversations(map, "lisbon").map((s) => s.id)).toEqual(["b"]);
  });

  it("returns [] when nothing matches", () => {
    expect(searchConversations(map, "quantum")).toEqual([]);
  });

  it("survives malformed conversations without throwing", () => {
    const ugly = { a: conv("a"), bad: null, worse: { nope: 1 } } as unknown as Record<string, ReturnType<typeof conv>>;
    expect(searchConversations(ugly, "").map((s) => s.id)).toEqual(["a"]);
  });

  it("carries a one-line snippet from the first user message", () => {
    const all = expectValid(ChatSummaryArray, searchConversations(map, ""), "summaries");
    const b = all.find((s) => s.id === "b")!;
    expect(b.snippet).toBe("find the cheapest flight to Lisbon");
    // The helper's default conversation has a user message — snippet reflects it.
    expect(all.find((s) => s.id === "a")!.snippet).toBe("hello from a");
  });

  it("hides the snippet line for conversations with no user messages", () => {
    const m = { e: conv("e", { title: "Empty", messages: [] }) };
    expect(searchConversations(m, "")[0].snippet).toBe("");
  });

  it("collapses whitespace and truncates long snippets with an ellipsis", () => {
    const long = `the first    paragraph
      of a long question that keeps going and going and going and going and going`;
    const m = { x: conv("x", { title: "T", messages: [{ role: "user", text: long, timestamp: 1 }] }) };
    const s = searchConversations(m, "")[0];
    expect(s.snippet.length).toBeLessThanOrEqual(90);
    expect(s.snippet.endsWith("…")).toBe(true);
    expect(s.snippet).not.toMatch(/\s{2,}/);
  });
});

describe("conversation schema accepts the new per-chat fields", () => {
  it("validates zoThreadId + pendingActions (and legacy chats without them)", () => {
    expectValid(
      ConversationSchema,
      conv("a", { zoThreadId: "conv_xyz", pendingActions: { reasoning: "why", actions: [{ type: "done", response: "ok" }] } }),
      "threaded conversation",
    );
    expectValid(ConversationSchema, conv("legacy"), "legacy conversation");
  });
});

// ---- wiring contracts (source-level, same pattern as tab-contexts.test.ts) ----

const bgCode = readFileSync(resolve(import.meta.dir, "../extension/background.js"), "utf-8");
const spCode = readFileSync(resolve(import.meta.dir, "../extension/sidepanel.js"), "utf-8");
const htmlCode = readFileSync(resolve(import.meta.dir, "../extension/sidepanel.html"), "utf-8");

describe("chat tabs — markup + sidepanel wiring", () => {
  it("has the tab bar and history search markup", () => {
    expect(htmlCode).toContain('id="chat-tabs"');
    expect(htmlCode).toContain('id="history-search"');
  });

  it("imports the chat-tabs ops and renders the bar", () => {
    expect(spCode).toMatch(/import \{[^}]*openChatTab[^}]*\} from ['"]\.\/lib\/chat-tabs\.js['"]/);
    expect(spCode).toContain("renderChatTabs");
    expect(spCode).toContain("closeChatTab");
    expect(spCode).toContain("pruneChatTabs");
  });

  it("threads chatId + per-chat conversationId through BOTH ASK_ZO payloads", () => {
    const payloads = [...spCode.matchAll(/type: 'ASK_ZO'/g)].length;
    expect(payloads).toBeGreaterThanOrEqual(2);
    expect(spCode).toMatch(/chatId: /);
    expect(spCode).toMatch(/conversationId: /);
    expect(spCode).toMatch(/zoThreadId/);
  });

  it("persists the echoed thread id + routes background streams by chat", () => {
    expect(spCode).toMatch(/streamSession\.chatId/);
    expect(spCode).toContain("pendingActions");
  });

  it("consumes the NEW_CONVERSATION keyboard shortcut", () => {
    expect(spCode).toMatch(/type: 'NEW_CONVERSATION'/);
  });

  it("renames + searches via the lib ops in the history view", () => {
    expect(spCode).toMatch(/import \{[^}]*(renameConversation|searchConversations)[^}]*\} from ['"]\.\/lib\/chat-tabs\.js['"]/);
  });
});

describe("chat tabs — background wiring", () => {
  it("uses the payload's thread id with the global as fallback", () => {
    // loop.threadId is seeded from the per-chat payload id; the global only
    // covers ambient callers (context menu / omnibox).
    expect(bgCode).toMatch(/threadId: msgThreadId\(msg\.conversationId\) \|\| null/);
    expect(bgCode).toMatch(/\(loop\.threadId \?\? zoConversationId\) \|\| undefined/);
  });

  it("echoes the thread id back on STREAM_DONE", () => {
    expect(bgCode).toMatch(/type: 'STREAM_DONE'[^;]*conversationId/s);
  });

  it("keys context state per chat (read_tab loop)", () => {
    expect(bgCode).toMatch(/const chatId = loop\.msg\?\.chatId/);
    expect(bgCode).toMatch(/loadConversationState\(chatId\)/);
    expect(bgCode).toMatch(/saveConversationState\(chatId, /);
  });
});
