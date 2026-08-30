// Integration: the REAL background.js service worker, imported as a module
// against the fake-chrome bus + a recording fetch mock. Exercises the message
// router, the streaming SSE pipeline (real fixtures through the real reader
// loop), the retry policy, the 3-path capture fallback, and EXECUTE_ACTIONS.
//
// NOTE: bun test shares the module registry across test files in one process,
// so every file that imports background.js must use a unique cache-busting
// query string (?file=...) to get a fresh instance bound to ITS bus.

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Window } from "happy-dom";
import {
  createFakeChrome,
  createTabTarget,
  stubNonZeroRects,
  waitUntil,
} from "../helpers/chrome-mock.ts";
import {
  ZoFetchMock,
  MOCK_ZO_TOKEN,
  sseResponse,
  sseEvent,
  zoSseText,
  jsonResponse,
  textResponse,
} from "../helpers/zo-fetch-mock.ts";

const CONTENT_SRC = readFileSync(resolve(import.meta.dir, "../../extension/content.js"), "utf-8");

/** Execute the real content.js IIFE with a page window baked in as parameters. */
function loadContentScript(win: any, chromeObj: any) {
  const run = new Function(
    "chrome", "document", "window", "location", "CSS", "Event",
    "MutationObserver", "setTimeout", "clearTimeout", "console",
    CONTENT_SRC,
  );
  run(chromeObj, win.document, win, win.location, win.CSS, win.Event,
    win.MutationObserver, setTimeout, clearTimeout, console);
}

const bus = createFakeChrome();
const fm = new ZoFetchMock();

/** Connect a fresh streaming port and record everything the background posts. */
function connectRecorder(): { seen: any[]; post: (msg: any) => void; peer: any } {
  const seen: any[] = [];
  const port = bus.runtime.connect({ name: "cobrowse-stream" });
  port.onMessage.addListener((m: any) => seen.push(m));
  return {
    seen,
    post: (msg: any) => port.postMessage(msg),
    peer: bus.runtime._lastPeer,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 25));

beforeAll(async () => {
  bus.storage.local._store.zoAccessToken = MOCK_ZO_TOKEN;
  fm.install();
  fm.handle(() => sseResponse(zoSseText({ text: "Hello world" })));
  (globalThis as any).chrome = bus;
  await import("../../extension/background.js?file=background-flow");
  await flush(); // let the import-time registrations + storage reads settle
});

describe("background message router", () => {
  it("GET_CONFIG returns the sanitized config with hasToken", async () => {
    const cfg = await bus.runtime.sendMessage({ type: "GET_CONFIG" });
    expect(cfg.zoApiUrl).toBe("https://api.zo.computer/zo/ask");
    expect(cfg.hasToken).toBe(true);
    expect(cfg.zoActiveMode).toBe("cobrowse");
  });

  it("registers the 5 context menu items at import", () => {
    const ids = bus.contextMenus._menus.map((m: any) => m.id);
    expect(bus.contextMenus._menus).toHaveLength(5);
    expect(ids).toContain("cobrowse-page");
    expect(ids).toContain("cobrowse-selection");
  });

  it("NEW_CONVERSATION resets the ambient thread in session storage", async () => {
    const resp = await bus.runtime.sendMessage({ type: "NEW_CONVERSATION" });
    expect(resp).toEqual({ ok: true });
    expect(bus.storage.session._store.zoConversationId).toBeNull();
  });
});

describe("background streaming pipeline", () => {
  it("ASK_ZO over the port: chunks → STREAM_DONE with the per-chat thread echoed", async () => {
    fm.handle(() => sseResponse(zoSseText({ text: "Hello world" })));
    const rec = connectRecorder();
    rec.post({
      sessionId: 1,
      type: "ASK_ZO",
      userQuery: "hi",
      modeId: "ask",
      chatId: "chat-1",
      conversationId: "thread-9",
    });
    await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_DONE"));

    const chunks = rec.seen.filter((m) => m.type === "STREAM_CHUNK");
    expect(chunks.map((m) => m.text).join("")).toBe("Hello world");
    const done = rec.seen.find((m) => m.type === "STREAM_DONE");
    expect(done.fullText).toBe("Hello world");
    expect(done.conversationId).toBe("thread-9"); // payload thread wins
    expect(done.actions).toEqual([]);
    // Every message is stamped with the query's session id (stale-filtering contract)
    expect(rec.seen.every((m) => m.sessionId === 1)).toBe(true);

    // The API request carried the prompt + per-chat thread + stream flag
    const req = fm.requests[fm.requests.length - 1];
    expect(req.url).toBe("https://api.zo.computer/zo/ask");
    expect(req.headers.authorization).toBe(`Bearer ${MOCK_ZO_TOKEN}`);
    expect(req.body.conversation_id).toBe("thread-9");
    expect(req.body.stream).toBe(true);
    expect(req.body.input).toContain("hi");
  });

  it("a transient network failure shows the reconnect banner — no terminal error — then completes (QA finding D)", async () => {
    let attempt = 0;
    fm.handle(() => {
      attempt++;
      if (attempt === 1) throw new Error("fetch failed");
      return sseResponse(zoSseText({ text: "Recovered" }));
    });
    const rec = connectRecorder();
    rec.post({ sessionId: 2, type: "ASK_ZO", userQuery: "q", modeId: "ask", chatId: "chat-2" });
    await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_DONE"), 8000);

    const types = rec.seen.map((m) => m.type);
    const reconnIdx = types.indexOf("STREAM_RECONNECT");
    const doneIdx = types.indexOf("STREAM_DONE");
    expect(reconnIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(reconnIdx);
    // The fix: NO STREAM_ERROR on the retried path — the old transient post
    // killed the panel session so the Reconnecting banner never showed.
    expect(rec.seen.some((m) => m.type === "STREAM_ERROR")).toBe(false);
    const reconn = rec.seen.find((m) => m.type === "STREAM_RECONNECT");
    expect(reconn.attempt).toBe(2);
    expect(reconn.maxRetries).toBe(3);
    expect(rec.seen.find((m) => m.type === "STREAM_DONE").fullText).toBe("Recovered");
  });

  it("all retries exhausted: ONE terminal STREAM_ERROR after the reconnect attempts (QA finding D)", async () => {
    fm.handle(() => { throw new Error("fetch failed"); });
    const rec = connectRecorder();
    rec.post({ sessionId: 6, type: "ASK_ZO", userQuery: "q", modeId: "ask", chatId: "chat-6" });
    await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_ERROR"), 15000);

    const errs = rec.seen.filter((m) => m.type === "STREAM_ERROR");
    expect(errs).toHaveLength(1); // terminal only — no transient per-attempt kills
    expect(errs[0].error).toContain("fetch failed");
    const lastReconnIdx = rec.seen.map((m) => m.type).lastIndexOf("STREAM_RECONNECT");
    expect(rec.seen.indexOf(errs[0])).toBeGreaterThan(lastReconnIdx);
    expect(rec.seen.filter((m) => m.type === "STREAM_RECONNECT").map((m) => m.attempt)).toEqual([2, 3]);
    expect(rec.seen.some((m) => m.type === "STREAM_DONE")).toBe(false);
  });

  it("a 4xx is terminal: surfaced error, wrapped error, final error — no retry, no DONE", async () => {
    fm.handle(() => textResponse("nope", 401));
    const rec = connectRecorder();
    rec.post({ sessionId: 3, type: "ASK_ZO", userQuery: "q", modeId: "ask", chatId: "chat-3" });
    await waitUntil(() =>
      rec.seen.some((m) => m.type === "STREAM_ERROR" && String(m.error).startsWith("Failed:")),
    );

    const errs = rec.seen.filter((m) => m.type === "STREAM_ERROR");
    expect(errs).toHaveLength(2); // impl's specific post + the handler's terminal wrap (QA finding D removed the third)
    expect(errs[0].error).toContain("Zo API error: 401");
    expect(errs[1].error).toContain("Failed: Zo API error: 401");
    expect(rec.seen.some((m) => m.type === "STREAM_RECONNECT")).toBe(false);
    expect(rec.seen.some((m) => m.type === "STREAM_DONE")).toBe(false);
  });

  it("streams without a token: immediate STREAM_ERROR, no API call", async () => {
    await bus.storage.local.set({ zoAccessToken: "" }); // onChanged → config drops it
    await flush();
    const before = fm.requests.length;
    const rec = connectRecorder();
    rec.post({ sessionId: 4, type: "ASK_ZO", userQuery: "q", modeId: "ask", chatId: "chat-4" });
    await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_ERROR"));
    expect(rec.seen.find((m: any) => m.type === "STREAM_ERROR").error).toContain("not configured");
    expect(fm.requests.length).toBe(before); // never hit the API
    await bus.storage.local.set({ zoAccessToken: MOCK_ZO_TOKEN }); // restore for later tests
    await flush();
  });

  it("a `failed` terminal event (HTTP 200) surfaces the server error — no empty DONE", async () => {
    // Live-verified shape (2026-08-19): server-side failures (e.g. unknown
    // model) stream `event: failed` with the error payload — over HTTP 200,
    // so the !response.ok branch never fires. Without the failed-terminal
    // handler this landed as an "empty response" message with the real
    // error dropped.
    fm.handle(() =>
      sseResponse([
        sseEvent("AgentRuntimeStreamChunk", { type: "status", status: "dispatching", error: null }),
        sseEvent("failed", { status: "failed", error: "Unknown model: nonexistent-model-xyz", runner_id: "r-1", error_type: "UserError", failure_owner: "ours", failure_kind: "unknown_model" }),
      ].join("\n")),
    );
    const rec = connectRecorder();
    rec.post({ sessionId: 5, type: "ASK_ZO", userQuery: "q", modeId: "ask", chatId: "chat-5" });
    await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_ERROR"));

    const err = rec.seen.find((m) => m.type === "STREAM_ERROR");
    expect(err.error).toContain("Unknown model: nonexistent-model-xyz");
    expect(err.error).toContain("UserError");
    expect(rec.seen.some((m) => m.type === "STREAM_DONE")).toBe(false); // never finishes "empty"
    expect(rec.seen.some((m) => m.type === "STREAM_RECONNECT")).toBe(false); // terminal, not retried
  });

  it("`completed` reporting status:failed surfaces the error too", async () => {
    fm.handle(() =>
      sseResponse([
        sseEvent("PartStartEvent", { index: 1, part: { part_kind: "text", content: "partial text" } }),
        sseEvent("completed", { status: "failed", error: "runner exploded", error_type: "InternalError" }),
      ].join("\n")),
    );
    const rec = connectRecorder();
    rec.post({ sessionId: 6, type: "ASK_ZO", userQuery: "q", modeId: "ask", chatId: "chat-6" });
    await waitUntil(() => rec.seen.some((m) => m.type === "STREAM_ERROR"));

    expect(rec.seen.find((m) => m.type === "STREAM_ERROR").error).toContain("runner exploded");
    expect(rec.seen.some((m) => m.type === "STREAM_DONE")).toBe(false);
  });

  it("non-streaming ASK_ZO fallback returns output + echoed thread id", async () => {
    fm.handle(() => jsonResponse({ output: "plain answer", conversation_id: "conv-ns" }));
    const resp = await bus.runtime.sendMessage({
      type: "ASK_ZO",
      userQuery: "q",
      modeId: "ask",
      chatId: "chat-9",
    });
    expect(resp.success).toBe(true);
    expect(resp.output).toBe("plain answer");
    expect(resp.conversationId).toBe("conv-ns");
  });
});

describe("background context capture — 3-path fallback", () => {
  const tabId = 42;
  let target: ReturnType<typeof createTabTarget>;

  beforeAll(() => {
    bus.tabs.registerTab({ id: tabId, url: "https://example.test/article", title: "Article", active: true });
    target = createTabTarget();
    target.onMessage.addListener((msg: any, _sender: any, sendResponse: Function) => {
      if (msg.type === "CAPTURE_CONTEXT") {
        sendResponse({
          url: "https://example.test/article",
          title: "Article",
          visibleText: "captured text",
          formFields: [{ tag: "input", selector: "#name" }],
          clickable: [],
        });
      } else if (msg.type === "EXECUTE_ACTION") {
        sendResponse({ ok: true, type: msg.action.type, value: msg.action.value });
        return true;
      }
    });
    bus.tabs.bindTab(tabId, target.onMessage);
  });

  it("GET_PAGE_CONTEXT: debugger refuses → content-script path answers, tabId stamped", async () => {
    const ctx = await bus.runtime.sendMessage({ type: "GET_PAGE_CONTEXT", tier: 2 });
    expect(ctx.visibleText).toBe("captured text");
    expect(ctx.formFields[0].selector).toBe("#name");
    expect(ctx.tabId).toBe(tabId);
    // Path 1 was attempted first (attach refused by the default fake), path 2 answered.
    expect(bus.debugger._calls.some((c: any) => c.api === "attach" && c.tabId === tabId)).toBe(true);
    expect(
      bus.tabs._calls.some((c: any) => c.api === "tabs.sendMessage" && c.tabId === tabId && c.msg?.type === "CAPTURE_CONTEXT"),
    ).toBe(true);
  });

  it("GET_PAGE_CONTEXT: when the CDP fast-path is available it wins and skips the tab round-trip", async () => {
    const captureCallsBefore = bus.tabs._calls.filter(
      (c: any) => c.api === "tabs.sendMessage" && c.msg?.type === "CAPTURE_CONTEXT",
    ).length;
    bus.debugger.enabled = true;
    bus.debugger.evalHandler = (expr: string) => {
      expect(expr).toContain("getBoundingClientRect"); // tier-2 element capture expression
      return { url: "https://cdp.test/", title: "CDP", formFields: [], clickable: [] };
    };
    try {
      const ctx = await bus.runtime.sendMessage({ type: "GET_PAGE_CONTEXT", tier: 2 });
      expect(ctx.title).toBe("CDP");
      expect(ctx.tabId).toBe(tabId);
      const captureCallsAfter = bus.tabs._calls.filter(
        (c: any) => c.api === "tabs.sendMessage" && c.msg?.type === "CAPTURE_CONTEXT",
      ).length;
      expect(captureCallsAfter).toBe(captureCallsBefore); // content path never reached
    } finally {
      bus.debugger.enabled = false;
      bus.debugger.evalHandler = null;
    }
  });

  it("EXECUTE_ACTIONS dispatches DOM actions to the tab and aggregates results", async () => {
    const resp = await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS",
      actions: [
        { type: "fill", selector: "#name", value: "X" },
        { type: "read_tab", ref: "T1" }, // filtered out by the background, never reaches the DOM
        { type: "done", response: "All done" },
      ],
      tabId,
    });
    expect(resp.ok).toBe(true);
    expect(resp.results.map((r: any) => r.type)).toEqual(["fill", "done"]);
    const executed = bus.tabs._calls.filter(
      (c: any) => c.api === "tabs.sendMessage" && c.tabId === tabId && c.msg?.type === "EXECUTE_ACTION",
    );
    expect(executed.map((c: any) => c.msg.action.type)).toEqual(["fill"]);
  });
});

describe("form-fill sensitivity gate (#26)", () => {
  const checkoutTabId = 77;
  const benignTabId = 78;
  const checkoutWin: any = new Window({ url: "https://shop.test/checkout" });
  const benignWin: any = new Window({ url: "https://example.test/search" });
  const pageDoc = checkoutWin.document;

  beforeAll(() => {
    // Checkout page: password + card fields inside a form with a submit button.
    checkoutWin.document.write(`<!DOCTYPE html><html><head><title>Checkout</title></head><body>
      <form>
        <label for="email">Email</label><input id="email" name="email" type="email">
        <label for="pw">Password</label><input id="pw" name="pw" type="password">
        <label for="cc">Card number</label><input id="cc" name="cc" inputmode="numeric">
        <button id="checkout-submit">Place order</button>
      </form>
      <a id="help-link" href="#help">Help</a>
    </body></html>`);
    stubNonZeroRects(checkoutWin);
    const checkoutTarget = createTabTarget();
    loadContentScript(checkoutWin, checkoutTarget.chrome);
    bus.tabs.registerTab({ id: checkoutTabId, url: "https://shop.test/checkout", title: "Checkout" });
    bus.tabs.bindTab(checkoutTabId, checkoutTarget.onMessage);

    // Benign search page: no sensitive fields, no sensitive URL.
    benignWin.document.write(`<!DOCTYPE html><html><head><title>Search</title></head><body>
      <form><input id="q" name="q" placeholder="Search"><button id="go-btn" type="button">Go</button></form>
      <a id="next-link" href="#next">Next</a>
    </body></html>`);
    stubNonZeroRects(benignWin);
    const benignTarget = createTabTarget();
    loadContentScript(benignWin, benignTarget.chrome);
    bus.tabs.registerTab({ id: benignTabId, url: "https://example.test/search", title: "Search" });
    bus.tabs.bindTab(benignTabId, benignTarget.onMessage);

    // probeClickTarget's executeScript path runs against the checkout DOM
    // (the debugger fast-path is refused by the default fake).
    bus.scripting.dom = checkoutWin;
  });

  it("fill_form on a sensitive form parks for confirmation; confirmed:true executes", async () => {
    const actions = [
      { type: "fill_form", values: [{ target: "Email", value: "a@b.c" }, { target: "Password", value: "" }] },
    ];

    const parked = await bus.runtime.sendMessage({ type: "EXECUTE_ACTIONS", actions, tabId: checkoutTabId });
    expect(parked.needsConfirm).toBe(true);
    expect(parked.reasons.join(" ")).toMatch(/password/i);
    expect(parked.actions).toEqual(actions);
    expect(parked.fields.some((f: any) => f.type === "password")).toBe(true);
    expect(parked.url).toContain("shop.test");
    // Parked = nothing executed: the email field is untouched.
    expect((pageDoc.querySelector("input[name=email]") as any).value).toBe("");

    const done = await bus.runtime.sendMessage({ type: "EXECUTE_ACTIONS", actions, tabId: checkoutTabId, confirmed: true });
    expect(done.ok).toBe(true);
    expect((pageDoc.querySelector("input[name=email]") as any).value).toBe("a@b.c");
    expect(done.results[0].fields.map((f: any) => f.target)).toEqual(["Email", "Password"]);
  });

  it("click on a submit button of a sensitive form is blocked by the backstop", async () => {
    const r = await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS",
      actions: [
        { type: "fill_form", values: [{ target: "Email", value: "a@b.c" }] },
        { type: "click", selector: "#checkout-submit" },
      ],
      tabId: checkoutTabId,
      confirmed: true,
    });
    expect(r.ok).toBe(false);
    expect(r.results[1].blocked).toBe(true);
    expect(r.results[1].error).toMatch(/blocked submit/i);
  });

  it("benign fill_form executes immediately (no confirm)", async () => {
    const r = await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS",
      actions: [{ type: "fill_form", values: [{ target: "Search", value: "hi" }] }],
      tabId: benignTabId,
    });
    expect(r.needsConfirm).toBeUndefined();
    expect(r.ok).toBe(true);
    expect((benignWin.document.querySelector("input[name=q]") as any).value).toBe("hi");
  });

  it("a non-submit click on a sensitive page is NOT blocked (submit buttons only)", async () => {
    const r = await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS",
      actions: [
        { type: "fill_form", values: [{ target: "Email", value: "a@b.c" }] },
        { type: "click", selector: "#help-link" },
      ],
      tabId: checkoutTabId,
      confirmed: true,
    });
    expect(r.ok).toBe(true);
    expect(r.results[1].blocked).toBeUndefined(); // probed, not a submit → allowed
  });

  it("a batch of PLAIN fill actions parks on a sensitive form too (models drift off fill_form)", async () => {
    // Live-observed on roboform.com: Zo emitted 30 individual fill{selector}
    // actions incl. password + card fields instead of one fill_form batch.
    // The gate must cover them — otherwise secrets auto-fill with no review.
    const actions = [
      { type: "fill", selector: "input[name=email]", value: "plain@b.c" },
      { type: "fill", selector: "input[type=password]", value: "hunter2" },
    ];
    const parked = await bus.runtime.sendMessage({ type: "EXECUTE_ACTIONS", actions, tabId: checkoutTabId });
    expect(parked.needsConfirm).toBe(true);
    expect(parked.reasons.join(" ")).toMatch(/password/i);
    // Parked = nothing executed (field still holds the earlier test's value).
    expect((pageDoc.querySelector("input[name=email]") as any).value).not.toBe("plain@b.c");

    const done = await bus.runtime.sendMessage({ type: "EXECUTE_ACTIONS", actions, tabId: checkoutTabId, confirmed: true });
    expect(done.ok).toBe(true);
    expect((pageDoc.querySelector("input[name=email]") as any).value).toBe("plain@b.c");
  });

  it("plain fills on a benign form execute immediately (no confirm)", async () => {
    const r = await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS",
      actions: [{ type: "fill", selector: "input[name=q]", value: "hi" }],
      tabId: benignTabId,
    });
    expect(r.needsConfirm).toBeUndefined();
    expect(r.ok).toBe(true);
    expect((benignWin.document.querySelector("input[name=q]") as any).value).toBe("hi");
  });

  it("after a fill on a page, Zo clicking an ACTION button is blocked (user rule)", async () => {
    // Co-browse contract: Zo fills, the USER clicks submit/OK/Next — on ANY
    // page, not just sensitive ones. Fill in one message, click in the next
    // (the sidepanel's per-action loop shape).
    bus.scripting.dom = benignWin;
    const fill = await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS",
      actions: [{ type: "fill", selector: "#q", value: "blocked-click-test" }],
      tabId: benignTabId,
    });
    expect(fill.ok).toBe(true);

    let goClicked = 0;
    benignWin.document.querySelector("#go-btn").addEventListener("click", () => { goClicked += 1; });
    const click = await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS",
      actions: [{ type: "click", selector: "#go-btn" }],
      tabId: benignTabId,
    });
    expect(click.ok).toBe(false);
    expect(click.results[0].blocked).toBe(true);
    expect(click.results[0].error).toMatch(/action-button click after a form fill/i);
    expect(goClicked).toBe(0);
  });

  it("links are still clickable after a fill (navigation ≠ form action)", async () => {
    bus.scripting.dom = benignWin;
    const fill = await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS",
      actions: [{ type: "fill", selector: "#q", value: "link-test" }],
      tabId: benignTabId,
    });
    expect(fill.ok).toBe(true);
    const click = await bus.runtime.sendMessage({
      type: "EXECUTE_ACTIONS",
      actions: [{ type: "click", selector: "#next-link" }],
      tabId: benignTabId,
    });
    expect(click.results[0].blocked).toBeUndefined();
    expect(click.ok).toBe(true);
  });
});

describe("debug diagnostics (#67)", () => {
  it("records metadata-only hops/durations while debugMode is on — and nothing while off", async () => {
    // Off by default: no recording.
    const off = await bus.runtime.sendMessage({ type: "GET_DEBUG_LOG" });
    expect(off.enabled).toBe(false);
    expect(off.entries).toHaveLength(0);

    // Flip the setting (storage.onChanged drives setEnabled in the background).
    await bus.storage.sync.set({ debugMode: true });
    await flush();
    // Some traffic: a capture + a stream turn.
    await bus.runtime.sendMessage({ type: "GET_PAGE_CONTEXT", tier: 0 });
    const port = connectRecorder();
    port.post({ sessionId: 1, type: "ASK_ZO", userQuery: "q", pageContext: { url: "https://example.test/", title: "Example", visibleText: "SECRET PAGE TEXT" }, effectiveTier: 0 });
    await flush();
    await flush();

    const on = await bus.runtime.sendMessage({ type: "GET_DEBUG_LOG" });
    expect(on.enabled).toBe(true);
    const kinds = new Set(on.entries.map((e: any) => e.kind));
    expect(kinds.has("msg")).toBe(true);
    expect(kinds.has("capture")).toBe(true);
    expect(kinds.has("stream")).toBe(true);
    const streamEntry = on.entries.find((e: any) => e.kind === "stream");
    expect(typeof streamEntry.durMs).toBe("number");

    // PRIVACY: the export must never carry page text.
    expect(JSON.stringify(on)).not.toContain("SECRET PAGE TEXT");
    expect(JSON.stringify(on)).not.toContain("SECRET");

    // Turning it off clears the buffer.
    await bus.storage.sync.set({ debugMode: false });
    await flush();
    const cleared = await bus.runtime.sendMessage({ type: "GET_DEBUG_LOG" });
    expect(cleared.enabled).toBe(false);
    expect(cleared.entries).toHaveLength(0);
  });

  it("CLEAR_DEBUG_LOG empties the ring", async () => {
    await bus.storage.sync.set({ debugMode: true });
    await flush();
    await bus.runtime.sendMessage({ type: "GET_PAGE_CONTEXT", tier: 0 });
    await flush();
    const before = await bus.runtime.sendMessage({ type: "GET_DEBUG_LOG" });
    expect(before.entries.length).toBeGreaterThan(0);
    await bus.runtime.sendMessage({ type: "CLEAR_DEBUG_LOG" });
    const after = await bus.runtime.sendMessage({ type: "GET_DEBUG_LOG" });
    // The ring records its own reader hop (by design — the listener logs
    // every message type); everything else is gone.
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0].label).toBe("GET_DEBUG_LOG");
    await bus.storage.sync.set({ debugMode: false });
  });
});
