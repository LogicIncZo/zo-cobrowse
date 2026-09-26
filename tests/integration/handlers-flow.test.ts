// Integration: background.js utility handlers dispatched through the fake
// bus — SAVE_PAGE, RUN_SKILL, CREATE/LIST_AUTOMATIONS, DUCKDB_QUERY,
// GENERATE_MODE, TEST_CONNECTION, LIST_MODELS/LIST_PERSONAS/GET_VISION_CATALOG,
// GET_OPEN_TABS, GET_TAB_CONTEXTS, NAVIGATE. These previously had only
// source-grep coverage (tests/background.test.ts); here they execute for
// real against the recording fetch mock.
//
// Cache-buster note: bun shares the module registry across test files in one
// process, so this file's background.js instance is bound to ITS bus via the
// unique ?file=handlers-flow query string. The no-token guard branches live
// in no-token-flow.test.ts (a second, token-less instance).

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
import { GenerateModeResultSchema } from "../schemas/zo-prompts.ts";
import { NavigateRequestSchema, ShareDiagnosticsResponseSchema } from "../schemas/debug-share.ts";

const bus = createFakeChrome();
const fm = new ZoFetchMock();

const flush = () => new Promise((r) => setTimeout(r, 25));

/** Validate against a Zod schema with a readable shape-drift error. */
function expectValid(schema: any, value: unknown) {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new Error(`shape drift: ${r.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}

beforeAll(async () => {
  bus.storage.local._store.zoAccessToken = MOCK_ZO_TOKEN;
  // #339: the space endpoint is no longer defaulted — seed it explicitly the
  // way a configured user would (Settings derives it from their username).
  bus.storage.local._store.zoSpaceEndpoint = "https://testspace.zo.space";
  fm.install();
  fm.handle(() => jsonResponse({ output: "ok" }));
  (globalThis as any).chrome = bus;
  await import("../../extension/background.js?file=handlers-flow");
  await flush();
});

afterAll(() => {
  fm.restore();
});

describe("SAVE_PAGE — save page to workspace (#09)", () => {
  it("derives the path from the title and posts an attributed markdown note", async () => {
    const resp = await bus.runtime.sendMessage({
      type: "SAVE_PAGE",
      pageContext: { title: "My Test Page!!", url: "https://src.dev/a", visibleText: "page body" },
    });
    expect(resp.ok).toBe(true);
    expect(resp.path).toBe("Documents/research/my-test-page.md");
    expect(resp.response).toBe("ok");

    const req = fm.to("/zo/ask")[0];
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe(`Bearer ${MOCK_ZO_TOKEN}`);
    expect(req.body.input).toContain("# My Test Page");
    expect(req.body.input).toContain("> **Source:** https://src.dev/a");
    expect(req.body.input).toContain("CONTENT START");
    expect(req.body.input).toContain("page body");
  });

  it("honors an explicit savePath", async () => {
    const resp = await bus.runtime.sendMessage({
      type: "SAVE_PAGE",
      pageContext: { title: "T", url: "https://src.dev/b", visibleText: "" },
      savePath: "Documents/notes/custom.md",
    });
    expect(resp.ok).toBe(true);
    expect(resp.path).toBe("Documents/notes/custom.md");
  });

  it("maps an HTTP failure to {ok:false, error}", async () => {
    fm.handle(() => textResponse("nope", 500));
    const resp = await bus.runtime.sendMessage({
      type: "SAVE_PAGE",
      pageContext: { title: "T", url: "https://src.dev/c", visibleText: "" },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Zo API error: 500");
  });
});

describe("RUN_SKILL — run a Zo skill (#04)", () => {
  it("posts a skill prompt carrying the skill name and page context", async () => {
    fm.handle(() => jsonResponse({ output: "skill ran" }));
    const resp = await bus.runtime.sendMessage({
      type: "RUN_SKILL",
      skillName: "summarize-page",
      pageContext: { url: "https://skill.dev/x", title: "Skill Target", visibleText: "skill body" },
    });
    expect(resp).toEqual({ ok: true, response: "skill ran" });

    const req = fm.to("/zo/ask").pop();
    expect(req.body.input).toContain('Run the skill named "summarize-page"');
    expect(req.body.input).toContain("Skill Target");
    expect(req.body.input).toContain("skill body");
  });

  it("maps a network failure to a 'Skill run failed' error", async () => {
    fm.handle(() => { throw new Error("fetch failed"); });
    const resp = await bus.runtime.sendMessage({ type: "RUN_SKILL", skillName: "x" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Skill run failed");
  });
});

describe("automations (#08)", () => {
  it("CREATE_AUTOMATION posts the instruction + RRULE", async () => {
    fm.handle(() => jsonResponse({ output: "created" }));
    const resp = await bus.runtime.sendMessage({
      type: "CREATE_AUTOMATION",
      instruction: "check the dashboard",
      rrule: "FREQ=HOURLY",
      pageContext: { url: "https://dash.dev/", title: "Dashboard" },
    });
    expect(resp).toEqual({ ok: true, response: "created" });

    const req = fm.to("/zo/ask").pop();
    expect(req.body.input).toContain("check the dashboard");
    expect(req.body.input).toContain("FREQ=HOURLY");
    expect(req.body.input).toContain("create_agent");
  });

  it("CREATE_AUTOMATION defaults the RRULE when omitted", async () => {
    fm.handle(() => jsonResponse({ output: "created" }));
    const resp = await bus.runtime.sendMessage({
      type: "CREATE_AUTOMATION",
      instruction: "tick",
    });
    expect(resp.ok).toBe(true);
    expect(fm.to("/zo/ask").pop().body.input).toContain("FREQ=DAILY");
  });

  it("LIST_AUTOMATIONS posts the inventory prompt and returns the response", async () => {
    fm.handle(() => jsonResponse({ output: "2 automations" }));
    const resp = await bus.runtime.sendMessage({ type: "LIST_AUTOMATIONS" });
    expect(resp).toEqual({ ok: true, response: "2 automations" });
    expect(fm.to("/zo/ask").pop().body.input).toContain("List all my automations");
  });

  it("maps an HTTP failure for CREATE_AUTOMATION", async () => {
    fm.handle(() => textResponse("nope", 503));
    const resp = await bus.runtime.sendMessage({ type: "CREATE_AUTOMATION", instruction: "x" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Zo API error: 503");
  });
});

describe("DUCKDB_QUERY — natural language SQL (#05)", () => {
  it("posts to the zo.space query endpoint and returns the result table", async () => {
    fm.handle((url) => {
      if (url.includes("/api/cobrowse/query")) {
        return jsonResponse({ columns: ["name", "n"], rows: [["a", 1], ["b", 2]], sql: "SELECT 1" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const resp = await bus.runtime.sendMessage({ type: "DUCKDB_QUERY", naturalQuery: "top pages" });
    expect(resp).toEqual({ ok: true, columns: ["name", "n"], rows: [["a", 1], ["b", 2]], sql: "SELECT 1", rowCount: 2 });

    const req = fm.to("/api/cobrowse/query")[0];
    expect(req.url).toContain("testspace.zo.space");
    expect(req.body).toEqual({ query: "top pages" });
  });

  it("maps an HTTP failure to a 'DuckDB query failed' error", async () => {
    fm.handle(() => textResponse("boom", 502));
    const resp = await bus.runtime.sendMessage({ type: "DUCKDB_QUERY", naturalQuery: "q" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("DuckDB query failed: 502");
    expect(resp.error).toContain("boom");
  });
});

describe("TEST_CONNECTION", () => {
  it("reports both endpoints green when Zo replies zo_ok and the space answers HEAD", async () => {
    fm.handle((url, init) => {
      if (url.includes("/zo/ask")) return jsonResponse({ output: "ZO_OK" });
      return jsonResponse({});
    });
    const resp = await bus.runtime.sendMessage({ type: "TEST_CONNECTION" });
    expect(resp).toEqual({ success: true, zoApi: true, zoSpace: true });
    expect(fm.to("/zo/ask").pop().body.input).toContain("ZO_OK");
    expect(fm.to("zo.space").length).toBeGreaterThan(0);
  });

  it("reports zoApi:false when the API is unreachable, zoSpace independently", async () => {
    fm.handle((url) => {
      if (url.includes("/zo/ask")) throw new Error("fetch failed");
      return jsonResponse({});
    });
    const resp = await bus.runtime.sendMessage({ type: "TEST_CONNECTION" });
    expect(resp).toEqual({ success: false, zoApi: false, zoSpace: true });
  });

  it("zo_ok missing from the body falls back to trusting r.ok", async () => {
    fm.handle((url, init) => {
      if (url.includes("/zo/ask")) return jsonResponse({ output: "hello" });
      throw new Error("space down");
    });
    const resp = await bus.runtime.sendMessage({ type: "TEST_CONNECTION" });
    expect(resp).toEqual({ success: true, zoApi: true, zoSpace: false });
  });
});

describe("model/persona/catalog endpoints", () => {
  it("LIST_MODELS returns the models array with the bearer header", async () => {
    fm.handle((url) => {
      if (url.includes("/models/available")) return jsonResponse({ models: [{ model_name: "m1", label: "M1" }] });
      throw new Error(`unexpected url ${url}`);
    });
    const resp = await bus.runtime.sendMessage({ type: "LIST_MODELS" });
    expect(resp).toEqual({ success: true, models: [{ model_name: "m1", label: "M1" }] });
    const req = fm.to("/models/available")[0];
    expect(req.headers.authorization).toBe(`Bearer ${MOCK_ZO_TOKEN}`);
  });

  it("LIST_MODELS maps a non-ok catalog response to {error}", async () => {
    fm.handle(() => textResponse("forbidden", 403));
    const resp = await bus.runtime.sendMessage({ type: "LIST_MODELS" });
    expect(resp).toEqual({ error: "HTTP 403" });
  });

  it("LIST_PERSONAS returns the personas array", async () => {
    fm.handle((url) => {
      if (url.includes("/personas/available")) return jsonResponse({ personas: [{ id: "p1" }] });
      throw new Error(`unexpected url ${url}`);
    });
    const resp = await bus.runtime.sendMessage({ type: "LIST_PERSONAS" });
    expect(resp).toEqual({ success: true, personas: [{ id: "p1" }] });
  });

  it("GET_VISION_CATALOG fetches the no-auth catalog and caches it (one fetch for two calls)", async () => {
    fm.handle((url) => {
      if (url.includes("/models/catalog")) return jsonResponse({ models: [{ value: "byok:m", supports_images: false }] });
      throw new Error(`unexpected url ${url}`);
    });
    const r1 = await bus.runtime.sendMessage({ type: "GET_VISION_CATALOG" });
    const r2 = await bus.runtime.sendMessage({ type: "GET_VISION_CATALOG" });
    expect(r1.success).toBe(true);
    expect(r1.models).toEqual([{ value: "byok:m", supports_images: false }]);
    expect(r2.models).toEqual(r1.models);
    // #73 session cache: the second call is served without a second round-trip.
    expect(fm.to("/models/catalog")).toHaveLength(1);
    // The catalog is deliberately no-auth.
    expect(fm.to("/models/catalog")[0].headers.authorization).toBeUndefined();
  });
});

describe("GENERATE_MODE — LLM custom-Mode generator", () => {
  it("returns a resolved custom Mode from a JSON reply", async () => {
    fm.handle((url, init) => {
      if (url.includes("/zo/ask")) {
        const raw = JSON.stringify({
          id: "gen_test",
          name: "Gen Mode",
          systemPrompt: "sp",
          instructions: "do x",
          contextTier: 2,
          expectJson: false,
        });
        return jsonResponse({ output: raw });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const resp = await bus.runtime.sendMessage({ type: "GENERATE_MODE", description: "a test mode" });
    expectValid(GenerateModeResultSchema, resp);
    expect(resp.success).toBe(true);
    expect(resp.mode.id).toBe("gen_test");
    expect(resp.mode.builtin).toBe(false);
    expect(resp.mode.contextTier).toBe(2);
    expect(resp.mode.createdAt).toBeGreaterThan(0);
    expect(fm.to("/zo/ask").pop().body.input).toContain("a test mode");
  });

  it("maps a non-JSON reply to a parse error", async () => {
    fm.handle(() => jsonResponse({ output: "not json at all" }));
    const resp = await bus.runtime.sendMessage({ type: "GENERATE_MODE", description: "d" });
    expect(resp).toEqual({ error: "Failed to parse Zo response as JSON" });
  });

  it("maps an HTTP failure to an error string", async () => {
    fm.handle(() => textResponse("boom", 500));
    const resp = await bus.runtime.sendMessage({ type: "GENERATE_MODE", description: "d" });
    expect(resp.error).toContain("HTTP 500");
  });
});

describe("tab handlers", () => {
  it("GET_OPEN_TABS lists capturable tabs MRU-first with host + active flags", async () => {
    const t1 = bus.tabs.registerTab({ title: "Old", url: "https://old.dev/", lastAccessed: 100, active: false });
    const t2 = bus.tabs.registerTab({ title: "Fresh", url: "https://fresh.dev/", lastAccessed: 300, active: true });
    bus.tabs.registerTab({ title: "Sys", url: "chrome://settings/", lastAccessed: 400, active: false });
    const t4 = bus.tabs.registerTab({ title: "Mid", url: "https://mid.dev/", lastAccessed: 200, active: false });

    const resp = await bus.runtime.sendMessage({ type: "GET_OPEN_TABS" });
    expect(resp.tabs.map((t: any) => t.tabId)).toEqual([t2.id, t4.id, t1.id]); // chrome:// filtered, MRU order
    expect(resp.tabs[0]).toEqual({
      tabId: t2.id, title: "Fresh", url: "https://fresh.dev/", host: "fresh.dev", active: true,
    });
  });

  it("GET_TAB_CONTEXTS joins captured excerpts for available tabs, degraded base otherwise", async () => {
    const t = bus.tabs.registerTab({ title: "Captured", url: "https://cap.dev/", active: false });
    const target = createTabTarget();
    target.onMessage.addListener((_msg: any, _sender: any, sendResponse: any) => {
      sendResponse({ url: "https://cap.dev/", title: "Captured", visibleText: "hello world", clickable: [{}, {}, {}] });
      return true;
    });
    bus.tabs.bindTab(t.id, target.onMessage);

    const resp = await bus.runtime.sendMessage({
      type: "GET_TAB_CONTEXTS",
      tabIds: [t.id, 987654], // second id unknown → degraded
      activeTabId: t.id,
    });
    expect(resp.tabs).toHaveLength(2);
    expect(resp.tabs[0]).toMatchObject({
      tabId: t.id, title: "Captured", url: "https://cap.dev/", host: "cap.dev",
      textLength: 11, elementCount: 3, excerpt: "hello world", isActive: true, available: true,
    });
    expect(resp.tabs[1]).toMatchObject({ tabId: 987654, available: false, isActive: false });
  });

  it("NAVIGATE updates the tab URL; missing url is rejected", async () => {
    const t = bus.tabs.registerTab({ title: "Nav", url: "https://from.dev/", active: false });
    const ok = await bus.runtime.sendMessage({ type: "NAVIGATE", tabId: t.id, url: "https://to.dev/" });
    expect(ok).toEqual({ ok: true, tabId: t.id });
    expect((await bus.tabs.get(t.id)).url).toBe("https://to.dev/");

    const bad = await bus.runtime.sendMessage({ type: "NAVIGATE", tabId: t.id });
    expect(bad).toEqual({ ok: false, error: "NAVIGATE requires tabId and url" });
  });

  it("NAVIGATE payload matches the schema contract (explicit tabId rides the send)", async () => {
    const r = NavigateRequestSchema.safeParse({ type: "NAVIGATE", url: "https://to.dev/", tabId: 7 });
    expect(r.success).toBe(true);
  });

  it("NAVIGATE without tabId falls back to the active non-extension tab (panel sends carry no sender.tab)", async () => {
    // Real Chrome keeps ONE active tab per window; earlier tests in this file
    // registered actives, so reset the field before this scenario.
    for (const t of bus.tabs._tabs) t.active = false;
    const active = bus.tabs.registerTab({ title: "Active", url: "https://active.dev/", active: true });
    const resp = await bus.runtime.sendMessage({ type: "NAVIGATE", url: "https://fallback.dev/" });
    expect(resp).toEqual({ ok: true, tabId: active.id });
    expect((await bus.tabs.get(active.id)).url).toBe("https://fallback.dev/");
  });

  it("NAVIGATE fallback refuses to drive an extension page", async () => {
    for (const t of bus.tabs._tabs) t.active = false;
    bus.tabs.registerTab({ title: "Ext", url: "chrome-extension://test-extension-id/options.html", active: true });
    const resp = await bus.runtime.sendMessage({ type: "NAVIGATE", url: "https://nope.dev/" });
    expect(resp).toEqual({ ok: false, error: "NAVIGATE: no browsable tab to navigate" });
  });
});

describe("SHARE_DIAGNOSTICS — anonymous 24h paste (user-triggered only)", () => {
  it("refuses honestly while debug diagnostics are off", async () => {
    const resp = await bus.runtime.sendMessage({ type: "SHARE_DIAGNOSTICS" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Debug diagnostics are off");
    const parsed = ShareDiagnosticsResponseSchema.safeParse(resp);
    expect(parsed.success).toBe(true);
  });

  it("with debugMode on, builds the bundle and attempts the paste hosts through fetch", async () => {
    bus.storage.sync.set({ debugMode: true });
    await flush();
    // The recording fetch mock answers every host with JSON (not a URL) —
    // both attempts must happen, and the failure must name them both.
    const resp = await bus.runtime.sendMessage({ type: "SHARE_DIAGNOSTICS" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("dpaste.com");
    expect(resp.error).toContain("0x0.st");
    expect(fm.to("dpaste.com/api/v2").length).toBeGreaterThanOrEqual(1);
    expect(fm.to("0x0.st").length).toBeGreaterThanOrEqual(1);
    bus.storage.sync.set({ debugMode: false });
    await flush();
  });

  it("the ring records the share attempt without persisting the paste URL", async () => {
    bus.storage.sync.set({ debugMode: true });
    await flush();
    await bus.runtime.sendMessage({ type: "SHARE_DIAGNOSTICS" });
    await bus.runtime.sendMessage({ type: "SHARE_DIAGNOSTICS" });
    const log = await bus.runtime.sendMessage({ type: "GET_DEBUG_LOG" });
    const shareEntries = log.entries.filter((e: any) => e.kind === "share");
    expect(shareEntries.length).toBeGreaterThanOrEqual(2);
    expect(shareEntries[0].label).toContain("paste-failed");
    const blob = JSON.stringify(log.entries);
    expect(blob).not.toContain("dpaste.com/"); // no paste URL rides the ring
    bus.storage.sync.set({ debugMode: false });
    await flush();
  });
});
