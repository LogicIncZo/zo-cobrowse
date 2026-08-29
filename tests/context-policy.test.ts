import { describe, it, expect } from "bun:test";
import {
  createConversationState,
  computePageHash,
  stripToPointer,
  decideTurn,
  CONVERSATION_STATE_KEY,
  stateKeyFor,
  loadConversationState,
  saveConversationState,
} from "../extension/lib/context-policy.js";
import { BUILTIN_MODES, TIER } from "../extension/lib/modes.js";
import { ConversationStateSchema, TurnDecisionSchema } from "./schemas/context-policy.js";

function expectValidState(s: unknown) {
  const p = ConversationStateSchema.safeParse(s);
  if (!p.success) throw new Error(`State failed schema:\n${JSON.stringify(s, null, 2)}\n${p.error.message}`);
  return p.data;
}
function expectValidDecision(d: unknown) {
  const p = TurnDecisionSchema.safeParse(d);
  if (!p.success) throw new Error(`Decision failed schema:\n${JSON.stringify(d, null, 2)}\n${p.error.message}`);
  return p.data;
}

const ctx = (overrides: Record<string, unknown> = {}) => ({
  url: "https://example.com",
  title: "Example",
  visibleText: "body text",
  clickable: [{ text: "A", tag: "a", selector: "#a" }],
  formFields: [{ tag: "input", selector: "#q" }],
  viewport: { w: 800, h: 600 },
  ...overrides,
});

describe("createConversationState", () => {
  it("starts with no capture and a zero turn counter", () => {
    expectValidState(createConversationState());
    expect(createConversationState()).toEqual({
      conversationId: null,
      lastCaptureHash: null,
      lastCaptureTier: null,
      turnsSinceFullCapture: 0,
      tabsSent: {},
      tabManifestSent: {},
    });
  });

  it("starts with an empty tab-context send-once map", () => {
    const s = createConversationState();
    expect(s.tabsSent).toEqual({});
    expect(Object.keys(s.tabsSent)).toHaveLength(0);
  });
});

describe("computePageHash", () => {
  it("is stable for identical input", () => {
    expect(computePageHash(ctx(), TIER.ELEMENTS)).toBe(computePageHash(ctx(), TIER.ELEMENTS));
  });

  it("changes when url/title change", () => {
    const a = computePageHash(ctx({ url: "https://a" }), TIER.ELEMENTS);
    const b = computePageHash(ctx({ url: "https://b" }), TIER.ELEMENTS);
    expect(a).not.toBe(b);
  });

  it("is tier-sensitive: text length matters at tier>=1, element counts at tier>=2", () => {
    const base = ctx();
    const h0 = computePageHash(base, TIER.POINTER);
    const h0b = computePageHash(ctx({ visibleText: "different length body!!" }), TIER.POINTER);
    // tier 0 ignores text → same hash despite different text.
    expect(h0).toBe(h0b);

    const h1 = computePageHash(base, TIER.TEXT);
    const h1b = computePageHash(ctx({ visibleText: "different length body!!" }), TIER.TEXT);
    expect(h1).not.toBe(h1b);

    const h2 = computePageHash(base, TIER.ELEMENTS);
    const h2b = computePageHash(ctx({ clickable: [{ text: "A", tag: "a", selector: "#a" }, { text: "B", tag: "a", selector: "#b" }] }), TIER.ELEMENTS);
    expect(h2).not.toBe(h2b);
  });
});

describe("stripToPointer", () => {
  it("returns only url/title/viewport", () => {
    const p = stripToPointer(ctx());
    expect(Object.keys(p).sort()).toEqual(["title", "url", "viewport"]);
    expect(p).not.toHaveProperty("visibleText");
    expect(p).not.toHaveProperty("clickable");
  });
  it("synthesizes a viewport when absent", () => {
    expect(stripToPointer({ url: "u", title: "t" }).viewport).toEqual({ w: "?", h: "?" });
  });
});

// ---- decideTurn — the full decision matrix ----------------------------------

describe("decideTurn — opt-in + send-once matrix", () => {
  it("read turn on a fresh conversation → URL only (no DOM by default)", () => {
    const hash = computePageHash(ctx(), TIER.TEXT);
    const d = decideTurn({
      mode: BUILTIN_MODES.ask, query: "What is this page about?",
      bang: null, state: createConversationState(), pageHash: hash,
    });
    expectValidDecision(d);
    expect(d.attach).toBe(false);
    expect(d.effectiveTier).toBe(0);
    expect(d.reason).toMatch(/Read/);
  });

  it("first action turn (cobrowse) → attaches element context", () => {
    const hash = computePageHash(ctx(), TIER.ELEMENTS);
    const d = decideTurn({
      mode: BUILTIN_MODES.cobrowse, query: "Click the login button",
      bang: null, state: createConversationState(), pageHash: hash,
    });
    expect(d.attach).toBe(true);
    expect(d.effectiveTier).toBe(BUILTIN_MODES.cobrowse.contextTier);
    expect(d.reason).toMatch(/First turn/);
    expect(d.newState.lastCaptureHash).toBe(hash);
    expect(d.newState.turnsSinceFullCapture).toBe(0);
  });

  it("follow-up action turn on the SAME page → URL only (send-once)", () => {
    const hash = computePageHash(ctx(), TIER.ELEMENTS);
    const state = { ...createConversationState(), lastCaptureHash: hash, lastCaptureTier: 2 };
    const d = decideTurn({
      mode: BUILTIN_MODES.cobrowse, query: "Now click the signup button",
      bang: null, state, pageHash: hash,
    });
    expect(d.attach).toBe(false);
    expect(d.effectiveTier).toBe(0);
    expect(d.reason).toMatch(/Follow-up/);
    expect(d.newState.turnsSinceFullCapture).toBe(1);
  });

  it("action turn after navigation (hash changed) → re-attaches", () => {
    const state = { ...createConversationState(), lastCaptureHash: "old-hash", lastCaptureTier: 2 };
    const d = decideTurn({
      mode: BUILTIN_MODES.cobrowse, query: "Click next",
      bang: null, state, pageHash: "new-hash",
    });
    expect(d.attach).toBe(true);
    expect(d.effectiveTier).toBe(BUILTIN_MODES.cobrowse.contextTier);
    expect(d.reason).toMatch(/Page changed/);
    expect(d.newState.lastCaptureHash).toBe("new-hash");
  });

  it("!context forces attach even for a read query, even on a same page", () => {
    const hash = computePageHash(ctx(), TIER.TEXT);
    const state = { ...createConversationState(), lastCaptureHash: hash, lastCaptureTier: 1 };
    const d = decideTurn({
      mode: BUILTIN_MODES.ask, query: "Summarize the pricing",
      bang: { kind: "context" }, state, pageHash: hash,
    });
    expect(d.attach).toBe(true);
    expect(d.effectiveTier).toBe(BUILTIN_MODES.ask.contextTier);
    expect(d.reason).toMatch(/!context/);
  });

  it("manual refresh forces attach (overrides send-once)", () => {
    const hash = computePageHash(ctx(), TIER.ELEMENTS);
    const state = { ...createConversationState(), lastCaptureHash: hash, lastCaptureTier: 2 };
    const d = decideTurn({
      mode: BUILTIN_MODES.cobrowse, query: "Click go",
      bang: null, state, pageHash: hash, forceRefresh: true,
    });
    expect(d.attach).toBe(true);
    expect(d.reason).toMatch(/Manual refresh/);
  });

  it("read-downgraded cobrowse query ('summarize') is treated as a read (tier 0)", () => {
    const hash = computePageHash(ctx(), TIER.ELEMENTS);
    const d = decideTurn({
      mode: BUILTIN_MODES.cobrowse, query: "Summarize this page",
      bang: null, state: createConversationState(), pageHash: hash,
    });
    // 'Summarize' is a read-only leader → not an action → URL only.
    expect(d.attach).toBe(false);
    expect(d.effectiveTier).toBe(0);
  });

  it("every decision validates against TurnDecisionSchema", () => {
    const cases = [
      { mode: BUILTIN_MODES.ask, query: "hi" },
      { mode: BUILTIN_MODES.cobrowse, query: "click x" },
      { mode: BUILTIN_MODES.cobrowse, query: "summarize" },
    ];
    const hash = computePageHash(ctx(), TIER.ELEMENTS);
    for (const c of cases) {
      const d = decideTurn({ mode: c.mode, query: c.query, bang: null, state: createConversationState(), pageHash: hash });
      expectValidDecision(d);
    }
  });
});

// ---- decideTurn — blank page (cold start: new/blank tab active) --------------

describe("decideTurn — blank page (cold start)", () => {
  it("read turn → no attach, tier 0, blank reason", () => {
    const d = decideTurn({
      mode: BUILTIN_MODES.ask, query: "research the best mechanical keyboards",
      bang: null, state: createConversationState(), pageHash: "chrome://newtab/|New Tab",
      pageBlank: true,
    });
    expectValidDecision(d);
    expect(d.attach).toBe(false);
    expect(d.effectiveTier).toBe(0);
    expect(d.reason).toMatch(/Blank page/);
  });

  it("action turn never attaches a blank page (nothing to attach)", () => {
    const d = decideTurn({
      mode: BUILTIN_MODES.cobrowse, query: "open hackernews and click the first story",
      bang: null, state: createConversationState(), pageHash: "chrome://newtab/|New Tab",
      pageBlank: true,
    });
    expect(d.attach).toBe(false);
    expect(d.effectiveTier).toBe(0);
    expect(d.reason).toMatch(/Blank page/);
  });

  it("!context and manual refresh are also skipped on a blank page", () => {
    for (const extra of [{ bang: { kind: "context" } }, { forceRefresh: true }]) {
      const d = decideTurn({
        mode: BUILTIN_MODES.ask, query: "summarize",
        bang: null, state: createConversationState(), pageHash: "x", pageBlank: true, ...extra,
      });
      expect(d.attach).toBe(false);
      expect(d.effectiveTier).toBe(0);
      expect(d.reason).toMatch(/Blank page/);
    }
  });

  it("blank turns record NO capture hash, so the first real-page action turn still attaches", () => {
    const afterBlank = decideTurn({
      mode: BUILTIN_MODES.cobrowse, query: "click go",
      bang: null, state: createConversationState(), pageHash: "chrome://newtab/|New Tab",
      pageBlank: true,
    }).newState;
    expectValidState(afterBlank);
    expect(afterBlank.lastCaptureHash).toBeNull();
    expect(afterBlank.turnsSinceFullCapture).toBe(1);
    // User navigates to a real page, then asks an action:
    const realHash = computePageHash(ctx(), TIER.ELEMENTS);
    const d = decideTurn({
      mode: BUILTIN_MODES.cobrowse, query: "click go",
      bang: null, state: afterBlank, pageHash: realHash,
    });
    expect(d.attach).toBe(true);
    expect(d.reason).toMatch(/First turn/);
  });
});

describe("context-policy module constants", () => {
  it("exposes a stable session-storage key", () => {
    expect(typeof CONVERSATION_STATE_KEY).toBe("string");
    expect(CONVERSATION_STATE_KEY.length).toBeGreaterThan(0);
  });
});

// ---- per-chat keyed storage (chat tabs isolation) ----

function stubSessionStore() {
  const store = new Map<string, unknown>();
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      session: {
        get: (key: string, cb: (r: Record<string, unknown>) => void) => cb(store.has(key) ? { [key]: store.get(key) } : {}),
        set: (obj: Record<string, unknown>, cb: () => void) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
          cb();
        },
      },
    },
  };
  return store;
}

describe("stateKeyFor", () => {
  it("keys per chat and falls back to the legacy global key", () => {
    expect(stateKeyFor("conv_1")).toBe(`${CONVERSATION_STATE_KEY}:conv_1`);
    expect(stateKeyFor(null)).toBe(CONVERSATION_STATE_KEY);
    expect(stateKeyFor(undefined)).toBe(CONVERSATION_STATE_KEY);
    expect(stateKeyFor("  ")).toBe(CONVERSATION_STATE_KEY);
  });
});

describe("loadConversationState / saveConversationState (per chat)", () => {
  it("stores each chat's state under its own key — no cross-chat leak", async () => {
    const store = stubSessionStore();
    const s1 = { ...createConversationState(), lastCaptureHash: "hash-a" };
    const s2 = { ...createConversationState(), lastCaptureHash: "hash-b" };
    await saveConversationState("chat1", s1);
    await saveConversationState("chat2", s2);
    expect(store.has(`${CONVERSATION_STATE_KEY}:chat1`)).toBe(true);
    expect(store.has(`${CONVERSATION_STATE_KEY}:chat2`)).toBe(true);

    const loaded1 = await loadConversationState("chat1");
    const loaded2 = await loadConversationState("chat2");
    expect(loaded1.lastCaptureHash).toBe("hash-a");
    expect(loaded2.lastCaptureHash).toBe("hash-b");
    expectValidState(loaded1);
  });

  it("stamps the reserved conversationId field with the chat id", async () => {
    stubSessionStore();
    await saveConversationState("chat9", createConversationState());
    const loaded = await loadConversationState("chat9");
    expect(loaded.conversationId).toBe("chat9");
    expectValidState(loaded);
  });

  it("returns a fresh state for a chat with nothing stored (and for legacy no-chat callers)", async () => {
    stubSessionStore();
    const fresh = await loadConversationState("never-seen");
    expect(fresh.lastCaptureHash).toBeNull();
    expect(fresh.conversationId).toBe("never-seen");
    const legacy = await loadConversationState();
    expect(legacy.conversationId).toBeNull();
  });

  it("survives a missing chrome runtime without throwing", async () => {
    (globalThis as Record<string, unknown>).chrome = undefined;
    const fresh = await loadConversationState("chat1");
    expect(fresh.lastCaptureHash).toBeNull();
    await expect(saveConversationState("chat1", createConversationState())).resolves.toBeUndefined();
  });
});

describe("decideTurn — hasThread guard (follow-up dedup safety)", () => {
  const mode = { expectJson: true, contextTier: 2 };
  const hash = "u|t|1|2|0";
  const captured = { ...createConversationState(), lastCaptureHash: hash, lastCaptureTier: 2 };

  it("re-attaches when the Zo thread is not established even on an unchanged page", () => {
    // Retry-after-failure: the previous turn recorded the capture hash but
    // died before the conversation_id echo — a fresh thread holds nothing.
    const d = decideTurn({ mode, query: "click submit", state: captured, pageHash: hash, hasThread: false });
    expectValidDecision(d);
    expect(d.attach).toBe(true);
    expect(d.effectiveTier).toBe(2);
    expect(d.reason).toContain("No thread yet");
  });

  it("keeps the follow-up dedup when the thread exists (default behavior preserved)", () => {
    const withThread = decideTurn({ mode, query: "click submit", state: captured, pageHash: hash, hasThread: true });
    expectValidDecision(withThread);
    expect(withThread.attach).toBe(false);
    expect(withThread.effectiveTier).toBe(0);
    expect(withThread.reason).toContain("Follow-up");
    // Legacy callers that don't pass hasThread at all behave identically.
    const legacy = decideTurn({ mode, query: "click submit", state: captured, pageHash: hash });
    expect(legacy.attach).toBe(false);
  });

  it("hasThread does not override explicit attaches or blank-page suppression", () => {
    const explicit = decideTurn({ mode, query: "q", state: captured, pageHash: hash, hasThread: false, forceRefresh: true });
    expect(explicit.attach).toBe(true);
    const blank = decideTurn({ mode, query: "click submit", state: captured, pageHash: hash, pageBlank: true, hasThread: false });
    expect(blank.attach).toBe(false);
  });

  it("creates fresh state carrying an empty tabManifestSent map", () => {
    const st = createConversationState();
    expect(st.tabManifestSent).toEqual({});
    expectValidState(st);
  });
});
