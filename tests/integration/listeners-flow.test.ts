// Integration: background.js extension-listener surfaces — context-menu
// clicks, keyboard commands (chrome.commands), the omnibox, onInstalled /
// onStartup, and the debugger onDetach cleanup. All of these previously had
// only source-grep coverage; here the real listeners fire on the fake bus
// and their observable effects are asserted (pendingZoQuery persistence,
// PENDING_ZO_QUERY / NEW_CONVERSATION broadcasts, side-panel opens,
// scripting reinjection, debugger bookkeeping).
//
// Unique ?file= cache-buster — one background.js instance bound to THIS bus.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createFakeChrome,
  createTabTarget,
  waitUntil,
} from "../helpers/chrome-mock.ts";
import {
  ZoFetchMock,
  MOCK_ZO_TOKEN,
  jsonResponse,
  textResponse,
} from "../helpers/zo-fetch-mock.ts";

const bus = createFakeChrome();
const fm = new ZoFetchMock();

const flush = () => new Promise((r) => setTimeout(r, 25));

const panelOpens: any[] = [];
const broadcasts: any[] = [];

/** Read the current pendingZoQuery handoff record (session storage). */
const pending = () => bus.storage.session._store.pendingZoQuery;

beforeAll(async () => {
  bus.storage.local._store.zoAccessToken = MOCK_ZO_TOKEN;
  fm.install();
  fm.handle(() => jsonResponse({ output: "ok" }));
  (globalThis as any).chrome = bus;
  await import("../../extension/background.js?file=listeners-flow");
  await flush();
  // Observable side-panel + broadcast recorder (listeners fire per event, so
  // rebinding the stub after import is safe).
  bus.sidePanel.open = (opts: any) => { panelOpens.push(opts); return Promise.resolve(); };
  bus.runtime.onMessage.addListener((msg: any) => { broadcasts.push(msg); });
});

afterAll(() => {
  fm.restore();
});

describe("context-menu click handler", () => {
  it("'cobrowse-page' opens the panel and parks the analyze query", async () => {
    const tab = bus.tabs.registerTab({ title: "Menu", url: "https://menu.dev/", active: true });
    bus.contextMenus.onClicked.emit({ menuItemId: "cobrowse-page" }, tab);
    await waitUntil(() => pending()?.source === "cobrowse-page");

    expect(panelOpens).toEqual([{ windowId: tab.windowId }]);
    expect(pending().text).toContain("Analyze this page");
    const bc = broadcasts.filter((m) => m.type === "PENDING_ZO_QUERY").pop();
    expect(bc).toMatchObject({ type: "PENDING_ZO_QUERY", source: "cobrowse-page" });
  });

  it("'cobrowse-selection' embeds the selected text", async () => {
    const tab = bus.tabs.registerTab({ title: "Sel", url: "https://sel.dev/", active: false });
    bus.contextMenus.onClicked.emit(
      { menuItemId: "cobrowse-selection", selectionText: "quantum flux capacitor" }, tab,
    );
    await waitUntil(() => pending()?.source === "cobrowse-selection");
    expect(pending().text).toContain("quantum flux capacitor");
  });

  it("'cobrowse-link' targets the link URL", async () => {
    const tab = bus.tabs.registerTab({ title: "Link", url: "https://link.dev/", active: false });
    bus.contextMenus.onClicked.emit(
      { menuItemId: "cobrowse-link", linkUrl: "https://target.dev/page" }, tab,
    );
    await waitUntil(() => pending()?.source === "cobrowse-link");
    expect(pending().text).toContain("https://target.dev/page");
  });

  it("'cobrowse-save' captures the page and parks a ✅ confirmation with the derived path", async () => {
    fm.handle(() => jsonResponse({ output: "saved" }));
    const tab = bus.tabs.registerTab({ title: "Save Me", url: "https://saveme.dev/x", active: false });
    const target = createTabTarget();
    target.onMessage.addListener((_m: any, _s: any, sendResponse: any) => {
      sendResponse({ url: "https://saveme.dev/x", title: "Save Me", visibleText: "body to save" });
      return true;
    });
    bus.tabs.bindTab(tab.id, target.onMessage);

    bus.contextMenus.onClicked.emit({ menuItemId: "cobrowse-save" }, tab);
    await waitUntil(() => pending()?.source === "save");

    expect(pending().text).toContain("✅ Saved to Documents/research/save-me.md");
    // The save POST carried the attributed markdown note.
    const req = fm.to("/zo/ask").pop();
    expect(req.body.input).toContain("CONTENT START");
    expect(req.body.input).toContain("> **Source:** https://saveme.dev/x");
  });

  it("'cobrowse-save' parks a ❌ failure line when the API errors", async () => {
    fm.handle(() => textResponse("nope", 500));
    const tab = bus.tabs.registerTab({ title: "Save Fail", url: "https://savefail.dev/", active: false });
    const target = createTabTarget();
    target.onMessage.addListener((_m: any, _s: any, sendResponse: any) => {
      sendResponse({ url: "https://savefail.dev/", title: "Save Fail", visibleText: "text" });
      return true;
    });
    bus.tabs.bindTab(tab.id, target.onMessage);

    bus.contextMenus.onClicked.emit({ menuItemId: "cobrowse-save" }, tab);
    await waitUntil(() => String(pending()?.text || "").startsWith("❌ Save failed"));
    expect(pending().text).toContain("Zo API error: 500");
  });
});

describe("keyboard commands (chrome.commands)", () => {
  it("'new-chat' broadcasts NEW_CONVERSATION without parking a query", async () => {
    const tab = bus.tabs.registerTab({ title: "Keys", url: "https://keys.dev/", active: false });
    const before = broadcasts.length;
    bus.commands.onCommand.emit("new-chat", tab);
    await waitUntil(() => broadcasts.slice(before).some((m) => m.type === "NEW_CONVERSATION"));

    expect(broadcasts.slice(before).find((m) => m.type === "NEW_CONVERSATION"))
      .toMatchObject({ type: "NEW_CONVERSATION", source: "shortcut" });
    // new-chat signals a fresh conversation — it never parks a pending query.
    expect(pending()?.source).not.toBe("shortcut-new-chat");
  });

  it("'summarize-page' parks the summarize query under the shortcut source", async () => {
    const tab = bus.tabs.registerTab({ title: "Keys2", url: "https://keys2.dev/", active: false });
    bus.commands.onCommand.emit("summarize-page", tab);
    await waitUntil(() => pending()?.source === "shortcut-summarize");
    expect(pending().text).toContain("Summarize this page");
  });

  it("'extract-page' parks the extract query under the shortcut source", async () => {
    const tab = bus.tabs.registerTab({ title: "Keys3", url: "https://keys3.dev/", active: false });
    bus.commands.onCommand.emit("extract-page", tab);
    await waitUntil(() => pending()?.source === "shortcut-extract");
    expect(pending().text).toContain("structured table");
  });

  it("'_execute_action' only opens the panel — no query, no broadcast", async () => {
    const tab = bus.tabs.registerTab({ title: "Keys4", url: "https://keys4.dev/", active: false });
    const before = broadcasts.length;
    const pendingBefore = pending();
    bus.commands.onCommand.emit("_execute_action", tab);
    await flush();
    await flush();

    expect(panelOpens[panelOpens.length - 1]).toEqual({ windowId: tab.windowId });
    expect(broadcasts.slice(before)).toEqual([]); // early return before any handoff
    expect(pending()).toEqual(pendingBefore);
  });
});

describe("omnibox (zo <query>)", () => {
  it("onInputStarted sets the default suggestion", () => {
    const before = bus.omnibox._defaultSuggestions.length;
    bus.omnibox.onInputStarted.emit();
    expect(bus.omnibox._defaultSuggestions.length).toBe(before + 1);
    expect(bus.omnibox._defaultSuggestions.at(-1).description).toContain("Ask Zo about this page");
  });

  it("onInputChanged with an empty string nudges toward !commands", () => {
    const suggested: any[] = [];
    bus.omnibox.onInputChanged.emit("   ", (s: any) => suggested.push(...s));
    expect(suggested).toEqual([]);
    expect(bus.omnibox._defaultSuggestions.at(-1).description).toContain("Type a question or !command");
  });

  it("onInputChanged with a known command prefix suggests the !command", () => {
    const suggested: any[] = [];
    bus.omnibox.onInputChanged.emit("sum", (s: any) => suggested.push(...s));
    expect(suggested).toEqual([{ content: "summarize", description: "zo summarize — Summarize this page" }]);
    expect(bus.omnibox._defaultSuggestions.at(-1).description).toContain("zo sum");
  });

  it("onInputChanged with free text proposes the raw query", () => {
    bus.omnibox.onInputChanged.emit("what is this page", () => {});
    expect(bus.omnibox._defaultSuggestions.at(-1).description).toContain('Ask Zo: "what is this page"');
  });

  it("onInputEntered normalizes a bare command to !command and parks it for the panel", async () => {
    const tab = bus.tabs.registerTab({ title: "Omnibox", url: "https://omni.dev/", active: false });
    bus.omnibox.onInputEntered.emit("research", "newForegroundTab");
    await waitUntil(() => pending()?.source === "omnibox");
    expect(pending().text).toBe("!research");
    expect(typeof pending().ts).toBe("number");
    expect(panelOpens[panelOpens.length - 1]).toEqual({ windowId: tab.windowId });
  });

  it("onInputEntered passes free-form text through unchanged", async () => {
    bus.tabs.registerTab({ title: "Omnibox2", url: "https://omni2.dev/", active: false });
    bus.omnibox.onInputEntered.emit("who made this site", "newForegroundTab");
    await waitUntil(() => pending()?.text === "who made this site");
    expect(pending().source).toBe("omnibox");
  });

  it("onInputEntered with an empty string is a no-op", async () => {
    const snapshot = JSON.stringify(pending());
    bus.omnibox.onInputEntered.emit("   ", "newForegroundTab");
    await flush();
    expect(JSON.stringify(pending())).toBe(snapshot);
  });
});

describe("lifecycle listeners", () => {
  it("onInstalled('update') flags the session and re-injects content.js into open tabs", async () => {
    const before = bus.tabs._calls.filter((c: any) => c.api === "scripting.executeScript").length;
    bus.runtime.onInstalled.emit({ reason: "update" });
    await waitUntil(() => bus.storage.session._store.cobrowse_updated_at > 0);
    // The mock's tabs.query ignores the URL filter, so every registered tab
    // is attempted; the injection itself is refused by the scripting fake
    // (no DOM) and skipped silently — the attempt is what's asserted here.
    const after = bus.tabs._calls.filter((c: any) => c.api === "scripting.executeScript").length;
    expect(after).toBeGreaterThan(before);
    expect(bus.tabs._calls.some((c: any) => c.api === "scripting.executeScript")).toBe(true);
  });

  it("onInstalled('install') does not flag the update banner", async () => {
    const snapshot = bus.storage.session._store.cobrowse_updated_at;
    bus.runtime.onInstalled.emit({ reason: "install" });
    await flush();
    expect(bus.storage.session._store.cobrowse_updated_at).toBe(snapshot);
  });

  it("onStartup re-creates the context menus", async () => {
    bus.runtime.onStartup.emit();
    await flush();
    const ids = bus.contextMenus._menus.map((m: any) => m.id);
    expect(bus.contextMenus._menus).toHaveLength(5);
    expect(ids).toContain("cobrowse-page");
    expect(ids).toContain("cobrowse-save");
  });
});

describe("debugger bookkeeping", () => {
  it("onDetach releases the tab captured via the CDP fast-path", async () => {
    // Route captures through the fake debugger so getActiveTabContext
    // attaches (and leaves attached) — exactly the state onDetach cleans up.
    bus.debugger.enabled = true;
    bus.debugger.evalHandler = () => ({ url: "https://dbg.dev/a", title: "Dbg", visibleText: "dbg text" });
    fm.handle(() => jsonResponse({ output: "saved" }));
    const tab = bus.tabs.registerTab({ title: "Dbg Save", url: "https://dbg-save.dev/", active: false });

    bus.contextMenus.onClicked.emit({ menuItemId: "cobrowse-save" }, tab);
    await waitUntil(() => bus.debugger._attached.has(tab.id), 5000);
    expect(bus.debugger._attached.has(tab.id)).toBe(true);
    expect(bus.debugger._calls.some((c: any) => c.api === "attach" && c.tabId === tab.id)).toBe(true);
    await waitUntil(() => pending()?.source === "save", 5000);

    bus.debugger.onDetach.emit({ tabId: tab.id });
    expect(bus.debugger._attached.has(tab.id)).toBe(false);
    expect(bus.debugger._calls.some((c: any) => c.api === "detach" && c.tabId === tab.id)).toBe(true);
  });

  it("onDetach without a tabId is a safe no-op", () => {
    expect(() => bus.debugger.onDetach.emit({})).not.toThrow();
    // Restore defaults for any later scenario in this process.
    bus.debugger.enabled = false;
    bus.debugger.evalHandler = null;
  });
});
