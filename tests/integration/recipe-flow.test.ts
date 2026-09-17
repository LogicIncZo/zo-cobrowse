// Integration: the Recipes player (#220) — the REAL background.js driving
// deterministic multi-step runs over the fake-chrome bus. Covers: RECIPE_START
// (local library + workspace MCP load), the needsParams round trip, the
// navigate→fill→extract→done happy path with ZERO LLM calls, human checkpoint
// park → resume-by-postcondition (+force fallback), the load-time and runtime
// submitish invariant, sensitive-page submit parking, cue-miss → blocked,
// STOP/terminal no-ops, the SW-restart orphan sweep, and RECIPE_LIST.
//
// The test plays the content script's role for tab 1 via a bound tab target
// (createTabTarget), scripting EXECUTE_ACTION results per scenario.
//
// NOTE: unique ?file= cache-buster — bun shares the module registry per process.

import { describe, it, expect, beforeAll } from "bun:test";
import { createFakeChrome, createTabTarget, waitUntil } from "../helpers/chrome-mock.ts";
import {
  ZoFetchMock,
  MOCK_ZO_TOKEN,
  jsonResponse,
  textResponse,
} from "../helpers/zo-fetch-mock.ts";
import { Recipe } from "../schemas/recipes.js";

const bus = createFakeChrome();
const fm = new ZoFetchMock();
const pushes: any[] = [];
bus.runtime.onMessage.addListener((m: any) => {
  if (m?.type === "RECIPE_UPDATE") pushes.push(m);
});
const notifications: any[] = [];
(bus as any).notifications = {
  create: (id: any, opts: any) => { notifications.push({ id, opts }); return id; },
};

const flush = () => new Promise((r) => setTimeout(r, 40));
const tabUrl = () => bus.tabs._tabs.find((t: any) => t.id === 1)?.url || "";

// ---- Fixtures -------------------------------------------------------------

const T0 = 1757800000000;

function makeRecipe(overrides: any = {}) {
  return {
    id: "rcp-it",
    name: "IT flow",
    version: "1.0.0",
    origin: "recipes/it.json",
    createdAt: T0,
    updatedAt: T0,
    params: [],
    steps: [
      { type: "navigate", url: "https://fixture.example/form", expectUrl: "/form" },
      { type: "fill", cues: [{ strategy: "question", value: "Applicant name" }], value: "Ada" },
      { type: "extract", cues: [{ strategy: "selector", value: "#reg" }], evidenceKey: "registration", label: "Registration" },
      { type: "done", message: "Filed: {{registration}}" },
    ],
    ...overrides,
  };
}

// The run the SW-restart sweep must pause at import time (seeded BEFORE the
// background import below).
bus.storage.session._store.cobrowse_recipe_runs = {
  "rec-preseed": {
    runId: "rec-preseed", recipeId: "rcp-pre", name: "Preseed", origin: "x",
    version: "1.0.0", chatId: "chat-pre", status: "running", stepIndex: 0,
    stepsTotal: 2, params: {}, evidence: [], healCount: 0,
    startedAt: T0, createdAt: T0, updatedAt: T0,
  },
};

// Learned-recipes library seeded before import — recipeLoad('local') reads it.
bus.storage.local._store.cobrowse_recipes = {
  rti: makeRecipe({ id: "rcp-rti", name: "RTI filing" }),
  other: makeRecipe({ id: "rcp-other", name: "Other", steps: [{ type: "done" }] }),
};

// ---- Fake content script for tab 1 ----------------------------------------

const target = createTabTarget();
let executeBehavior: (action: any) => any = (action) => ({ ok: true, type: action.step?.type ?? action.type });
let captureBehavior: () => any = () => ({ url: tabUrl(), title: "Fixture page", formFields: [], clickable: [] });
// The healer's one-shot /zo/ask call (null → default {} response → parse fail).
let askResponder: (() => any) | null = null;
const executedSteps: any[] = [];
// R2 (#256): files written via MCP write_file during tests — read_file serves
// them back so save → load round-trips on the bus.
const savedFiles = new Map<string, string>();
target.onMessage.addListener((msg: any, _sender: any, sendResponse: Function) => {
  if (msg.type === "CAPTURE_CONTEXT") {
    sendResponse(captureBehavior());
    return true;
  }
  if (msg.type === "EXECUTE_ACTION") {
    if (msg.action?.step) executedSteps.push(msg.action.step);
    sendResponse(executeBehavior(msg.action));
    return true;
  }
});
bus.tabs.bindTab(1, target.onMessage);

beforeAll(async () => {
  bus.storage.local._store.zoAccessToken = MOCK_ZO_TOKEN;
  await bus.tabs.create({ id: 1, url: "https://fixture.example/start", active: true });
  fm.install();
  fm.handle((url, _init, req) => {
    if (url.includes("/zo/ask") && askResponder) return askResponder();
    if (!url.endsWith("/mcp")) return jsonResponse({});
    const body: any = (req as any).body || {};
    if (body.method === "initialize") {
      return jsonResponse(
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "zo-tools", version: "1.0.0" } } },
        { headers: { "mcp-session-id": "sess-1" } },
      );
    }
    if (body.method === "notifications/initialized") return textResponse("", 202);
    if (body.method === "tools/call" && body.params?.name === "write_file") {
      const targetFile = String(body.params.arguments?.target_file || "");
      savedFiles.set(targetFile, String(body.params.arguments?.content || ""));
      return jsonResponse({
        jsonrpc: "2.0", id: body.id,
        result: { isError: false, content: [{ type: "text", text: "ok" }] },
      });
    }
    if (body.method === "tools/call" && body.params?.name === "read_file") {
      // Route by path: the #228 source-notes path returns plain notes text.
      const targetFile = String(body.params.arguments?.target_file || "");
      if (savedFiles.has(targetFile)) {
        return jsonResponse({
          jsonrpc: "2.0", id: body.id,
          result: { isError: false, content: [{ type: "text", text: JSON.stringify([savedFiles.get(targetFile), "file_ref"]) }] },
        });
      }
      if (targetFile.includes("notes/source.md")) {
        return jsonResponse({
          jsonrpc: "2.0", id: body.id,
          result: { isError: false, content: [{ type: "text", text: JSON.stringify(["INTEGRATION-SOURCE-CONTENT: draft notes.", "file_ref"]) }] },
        });
      }
      const wsRecipe = makeRecipe({ id: "rcp-ws", name: "Workspace recipe", origin: "/home/workspace/recipes/rti.json" });
      // Live shape (2026-09-14): a JSON array [fileText, fileRefLine].
      return jsonResponse({
        jsonrpc: "2.0", id: body.id,
        result: { isError: false, content: [{ type: "text", text: JSON.stringify([JSON.stringify(wsRecipe), "file_ref"]) }] },
      });
    }
    if (body.method === "tools/call" && body.params?.name === "bash") {
      const cmd = String(body.params.arguments?.cmd || "");
      if (cmd.startsWith("base64")) {
        // CmdResult Python-repr wrapper with our markers, like the live tool.
        const b64 = Buffer.from("PDFBYTES").toString("base64");
        return jsonResponse({
          jsonrpc: "2.0", id: body.id,
          result: { isError: false, content: [{ type: "text", text: `CmdResult(stdout='__ZO_BEGIN__\\n${b64}\\n__ZO_END__\\n', stderr='', returncode=0)` }] },
        });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "unexpected command" }] } });
    }
    return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
  });
  (globalThis as any).chrome = bus;
  await import("../../extension/background.js?file=recipe-flow");
  await flush();
});

// ---- Helpers ---------------------------------------------------------------

async function start(source: any, paramValues?: any) {
  return bus.runtime.sendMessage({
    type: "RECIPE_START", chatId: `chat-${Math.random().toString(36).slice(2, 8)}`,
    tabId: 1, source, ...(paramValues ? { paramValues } : {}),
  });
}

async function settle(runId: string, statuses = ["done", "blocked", "aborted", "waiting_human", "paused"], timeout = 15000): Promise<any> {
  let last: any = null;
  await waitUntil(() => {
    last = bus.storage.session._store.cobrowse_recipe_runs[runId] || null;
    return !!last && statuses.includes(last.status);
  }, timeout);
  return last;
}

// ---- Tests -----------------------------------------------------------------

describe("recipes player (#220)", () => {
  it("SW-restart sweep paused the preseeded running run at import time", () => {
    const pre = bus.storage.session._store.cobrowse_recipe_runs["rec-preseed"];
    expect(pre.status).toBe("paused");
    expect(pre.stopReason).toContain("extension restarted");
  });

  it("happy path: navigate → fill → extract → done with ZERO LLM calls", async () => {
    const asksBefore = fm.to("/zo/ask").length;
    executeBehavior = (action) => {
      const st = action.step;
      if (st.type === "extract") return { ok: true, type: "extract", value: "REG-2026-000123" };
      return { ok: true, type: st.type };
    };
    const res = await start({ localName: "rti" });
    expect(res.ok).toBe(true);
    const run = await settle(res.run.runId, ["done"]);
    expect(run.status).toBe("done");
    expect(run.evidence).toHaveLength(1);
    expect(run.evidence[0]).toMatchObject({ key: "registration", value: "REG-2026-000123" });
    expect(run.stopReason).toBe("Filed: REG-2026-000123"); // {{evidence}} interpolated
    expect(fm.to("/zo/ask").length).toBe(asksBefore); // deterministic — no model turn
    // The player pushed updates as it went.
    const mine = pushes.filter((p) => p.run.runId === run.runId).map((p) => p.run.status);
    expect(mine).toContain("running");
    expect(mine).toContain("done");
    expect(notifications.find((n) => n.id === `recipe-${run.runId}`)?.opts.title).toBe("Recipe finished");
  });

  it("required params gate the start; values substitute into steps", async () => {
    bus.storage.local._store.cobrowse_recipes.paramed = makeRecipe({
      id: "rcp-param", name: "Paramed",
      params: [{ name: "applicant", type: "string", required: true, question: "Who is applying?" }],
      steps: [
        { type: "navigate", url: "https://fixture.example/form", expectUrl: "/form" },
        { type: "fill", cues: [{ strategy: "question", value: "Applicant name" }], value: "{{applicant}}" },
        { type: "done" },
      ],
    });
    executedSteps.length = 0;
    const gated = await start({ localName: "paramed" });
    expect(gated.ok).toBe(false);
    expect(gated.needsParams).toBe(true);
    expect(gated.params[0].name).toBe("applicant");

    const res = await start({ localName: "paramed" }, { applicant: "Grace Hopper" });
    expect(res.ok).toBe(true);
    const run = await settle(res.run.runId, ["done"]);
    expect(run.status).toBe("done");
    const fill = executedSteps.find((s) => s.type === "fill");
    expect(fill.value).toBe("Grace Hopper");
  });

  it("human checkpoint parks the run; resume verifies the postcondition", async () => {
    bus.storage.local._store.cobrowse_recipes.checkpoint = makeRecipe({
      id: "rcp-ckpt", name: "Checkpointed",
      steps: [
        { type: "navigate", url: "https://fixture.example/form", expectUrl: "/form" },
        { type: "human", title: "Pay ₹10", instructions: "Complete the captcha and payment.", resumeOn: { url: "/paid" } },
        { type: "done", message: "paid flow done" },
      ],
    });
    const res = await start({ localName: "checkpoint" });
    expect(res.ok).toBe(true);
    const waiting = await settle(res.run.runId, ["waiting_human"]);
    expect(waiting.status).toBe("waiting_human");
    expect(waiting.humanTitle).toBe("Pay ₹10");
    expect(notifications.find((n) => n.id === `recipe-${waiting.runId}`)?.opts.title).toBe("Recipe needs you");

    // Not on the postcondition page yet → honest refusal, still waiting.
    const early = await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: waiting.runId });
    expect(early.ok).toBe(false);
    expect(early.error).toContain("resume condition not met");
    const still = await bus.runtime.sendMessage({ type: "RECIPE_STATUS", runId: waiting.runId });
    expect(still.run.status).toBe("waiting_human");

    // The user finishes payment → the tab lands on /paid → resume verifies.
    await bus.tabs.update(1, { url: "https://fixture.example/paid" });
    const ok = await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: waiting.runId });
    expect(ok.ok).toBe(true);
    const done = await settle(waiting.runId, ["done"]);
    expect(done.status).toBe("done");
    expect(done.stopReason).toBe("paid flow done");
  });

  it("force resume is the manual fallback past an unverified checkpoint", async () => {
    bus.storage.local._store.cobrowse_recipes.forced = makeRecipe({
      id: "rcp-force", name: "Forced",
      steps: [
        { type: "human", title: "Manual step", instructions: "Do the thing.", resumeOn: { url: "/nowhere" } },
        { type: "done" },
      ],
    });
    const res = await start({ localName: "forced" });
    const waiting = await settle(res.run.runId, ["waiting_human"]);
    const ok = await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: waiting.runId, force: true });
    expect(ok.ok).toBe(true);
    const done = await settle(waiting.runId, ["done"]);
    expect(done.status).toBe("done");
  });

  it("load-time invariant: an undeclared submitish click refuses to start", async () => {
    bus.storage.local._store.cobrowse_recipes.badinv = makeRecipe({
      id: "rcp-bad", name: "Bad invariant",
      steps: [
        { type: "click", cues: [{ strategy: "text", value: "Submit" }], submitish: true },
        { type: "done" },
      ],
    });
    const res = await start({ localName: "badinv" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid recipe");
    expect((res.errors || []).some((e: string) => e.includes("submitish"))).toBe(true);
  });

  it("runtime safety: a submitish click after a human step still parks on a sensitive page", async () => {
    bus.storage.local._store.cobrowse_recipes.sens = makeRecipe({
      id: "rcp-sens", name: "Sensitive",
      steps: [
        { type: "human", title: "Review", instructions: "Check the details.", resumeOn: { url: "/form" } },
        { type: "click", cues: [{ strategy: "text", value: "Pay Now" }], submitish: true },
        { type: "done" },
      ],
    });
    captureBehavior = () => ({ url: "https://fixture.example/checkout", title: "Checkout", formFields: [{ tag: "input", type: "password", name: "pw" }] });
    const res = await start({ localName: "sens" });
    const waiting = await settle(res.run.runId, ["waiting_human"]);
    const ok = await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: waiting.runId, force: true });
    expect(ok.ok).toBe(true);
    const blocked = await settle(waiting.runId, ["blocked"]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.stopReason).toContain("the submit stays yours");
    expect(notifications.find((n) => n.id === `recipe-${blocked.runId}`)?.opts.title).toBe("Recipe run blocked");
  });

  it("P1 (#266): an UNdeclared submit click on a sensitive page refuses in-page and parks", async () => {
    bus.storage.local._store.cobrowse_recipes.undecl = makeRecipe({
      id: "rcp-undecl", name: "Undeclared submit",
      steps: [
        { type: "click", cues: [{ strategy: "text", value: "Place order" }] }, // no submitish flag
        { type: "done" },
      ],
    });
    captureBehavior = () => ({ url: "https://fixture.example/checkout", title: "Checkout", formFields: [{ tag: "input", type: "password", name: "pw" }] });
    let sawSensitive: unknown;
    executeBehavior = (action) => {
      sawSensitive = action.sensitive;
      // The content executor's refusal shape (lib/formfill.js#isSensitiveSubmitProbe twin).
      return { ok: false, type: "click", refused: "sensitive-submit", probeText: "Place order" };
    };
    const res = await start({ localName: "undecl" });
    const blocked = await settle(res.run.runId, ["blocked"]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.stopReason).toContain("the submit stays yours");
    expect(sawSensitive).toBe(true); // the flag rides the action so the executor can probe
  });

  it("P1 (#266): a non-submit click on a sensitive page still plays", async () => {
    bus.storage.local._store.cobrowse_recipes.sensok = makeRecipe({
      id: "rcp-sensok", name: "Sensitive ok",
      steps: [
        { type: "click", cues: [{ strategy: "text", value: "Details" }] },
        { type: "done" },
      ],
    });
    captureBehavior = () => ({ url: "https://fixture.example/checkout", title: "Checkout", formFields: [{ tag: "input", type: "password", name: "pw" }] });
    executeBehavior = (action) => ({ ok: true, type: action.step?.type ?? action.type });
    const res = await start({ localName: "sensok" });
    const done = await settle(res.run.runId, ["done"]);
    expect(done.status).toBe("done");
  });

  it("P3 (#270): force resume records the unverified-postcondition warning", async () => {
    bus.storage.local._store.cobrowse_recipes.fwarn = makeRecipe({
      id: "rcp-fwarn", name: "Force warn",
      steps: [
        { type: "human", title: "Do it by hand", instructions: "Finish the step.", resumeOn: { url: "/nowhere" } },
        { type: "done" },
      ],
    });
    captureBehavior = () => ({ url: "https://fixture.example/form", title: "Fixture page", formFields: [] });
    executeBehavior = (action) => ({ ok: true, type: action.step?.type ?? action.type });
    const res = await start({ localName: "fwarn" });
    const waiting = await settle(res.run.runId, ["waiting_human"]);
    const ok = await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: waiting.runId, force: true });
    expect(ok.ok).toBe(true);
    const done = await settle(waiting.runId, ["done"]);
    expect(done.status).toBe("done");
    expect((done.warnings || []).some((w: string) => w.includes("postcondition not verified"))).toBe(true);
  });

  it("cue-miss spends the healer one-shot; a useless reply parks the run blocked", async () => {
    bus.storage.local._store.cobrowse_recipes.missy = makeRecipe({
      id: "rcp-miss", name: "Missy",
      steps: [
        { type: "fill", cues: [{ strategy: "question", value: "Ghost field" }], value: "x" },
        { type: "done" },
      ],
    });
    executeBehavior = () => ({ ok: false, type: "fill", cueMiss: true, tried: ["question=Ghost field"], candidates: [], error: "no element matched cues: question=Ghost field" });
    askResponder = null; // default {} → healer parse failure
    const res = await start({ localName: "missy" });
    const blocked = await settle(res.run.runId, ["blocked"]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.stopReason).toContain("healer");
    expect(blocked.healCount).toBe(0); // the patch never landed
  });

  it("healer: cue-miss → one-shot re-ground → patch + version bump + retry to done", async () => {
    bus.storage.local._store.cobrowse_recipes.healx = makeRecipe({
      id: "rcp-healx", name: "Heal me", version: "2.1.0",
      steps: [
        { type: "fill", cues: [{ strategy: "question", value: "Ghost field" }], value: "Ada" },
        { type: "done" },
      ],
    });
    executedSteps.length = 0;
    executeBehavior = (action) => {
      const st = action.step;
      // First attempt misses; the healed cue array resolves.
      if (st.type === "fill" && st.cues[0]?.value === "Ghost field") {
        return { ok: false, type: "fill", cueMiss: true, tried: ["question=Ghost field"], candidates: [{ text: "Your name", selector: "#fullname" }], error: "no element matched" };
      }
      return { ok: true, type: st.type };
    };
    captureBehavior = () => ({
      url: "https://fixture.example/form",
      title: "Fixture page",
      // A sensitive value that must NEVER reach the healer prompt.
      formFields: [{ tag: "input", type: "password", name: "pw", value: "hunter2", selector: "#pw", question: "Password" }],
    });
    askResponder = () => jsonResponse({ output: JSON.stringify({ cues: [{ strategy: "selector", value: "#fullname" }, { strategy: "question", value: "Your name" }], note: "renamed field" }) });
    const res = await start({ localName: "healx" });
    expect(res.ok).toBe(true);
    const run = await settle(res.run.runId, ["done"]);
    expect(run.status).toBe("done");
    expect(run.healCount).toBe(1);
    expect(run.version).toBe("2.1.1"); // patch bump on heal
    // The retry executed the PATCHED cues.
    const retried = executedSteps.filter((s) => s.type === "fill");
    expect(retried.length).toBe(2);
    expect(retried[1].cues.map((c: any) => c.value)).toContain("#fullname");
    // The healed copy is cached in the local library under the recipe id.
    const cached = bus.storage.local._store.cobrowse_recipes["rcp-healx"];
    expect(cached?.steps[0].cues.map((c: any) => c.value)).toContain("#fullname");
    // Redaction: the healer prompt carried field structure, never values.
    const asks = fm.to("/zo/ask");
    const healAsk = [...fm.to("/zo/ask")].reverse().find((a: any) => String(a.body?.input || "").includes('Recipe "Heal me"'));
    expect(healAsk).toBeTruthy();
    const prompt = String(healAsk.body.input);
    expect(prompt).toContain("question=Ghost field");
    expect(prompt).toContain("Your name");
    expect(prompt).not.toContain("hunter2");
    askResponder = null;
  });

  it("STOP aborts a live run; resume on a terminal run is refused", async () => {
    const res = await start({ localName: "rti" });
    expect(res.ok).toBe(true);
    const stop = await bus.runtime.sendMessage({ type: "RECIPE_STOP", runId: res.run.runId, reason: "user asked" });
    expect(stop.ok).toBe(true);
    expect(stop.run.status).toBe("aborted");
    const late = await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: res.run.runId });
    expect(late.ok).toBe(false);
    expect(late.error).toContain("not resumable");
    // Re-stop is the #160 no-op: no double notify, no re-push.
    const again = await bus.runtime.sendMessage({ type: "RECIPE_STOP", runId: res.run.runId });
    expect(again.ok).toBe(false);
    expect(again.error).toContain("already aborted");
  });

  it("paused runs resume by replaying the current step", async () => {
    bus.storage.local._store.cobrowse_recipes.resumable = makeRecipe({
      id: "rcp-res", name: "Resumable",
      steps: [
        { type: "fill", cues: [{ strategy: "question", value: "Applicant name" }], value: "Ada" },
        { type: "done" },
      ],
    });
    executeBehavior = (action) => ({ ok: true, type: action.step?.type ?? action.type });
    const res = await start({ localName: "resumable" });
    expect(res.ok).toBe(true);
    // Simulate the SW dying mid-run (what the orphan sweep does).
    const runs = bus.storage.session._store.cobrowse_recipe_runs;
    runs[res.run.runId].status = "paused";
    runs[res.run.runId].stopReason = "extension restarted — resume to continue";
    const ok = await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: res.run.runId });
    expect(ok.ok).toBe(true);
    const done = await settle(res.run.runId, ["done"]);
    expect(done.status).toBe("done");
  });

  it("workspace recipes load over MCP read_file; unsafe paths are refused", async () => {
    executeBehavior = (action) => ({ ok: true, type: action.step?.type ?? action.type });
    const res = await start({ workspacePath: "/home/workspace/recipes/rti.json" });
    expect(res.ok).toBe(true);
    expect(res.run.name).toBe("Workspace recipe");
    const run = await settle(res.run.runId, ["done"]);
    expect(run.status).toBe("done");

    const refused = await start({ workspacePath: "/etc/passwd" });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("inside /home/workspace");
  });

  it("attach fetches the file as base64 over the bash MCP tool", async () => {
    bus.storage.local._store.cobrowse_recipes.attachy = makeRecipe({
      id: "rcp-att", name: "With attach",
      steps: [
        { type: "attach", cues: [{ strategy: "selector", value: "#file" }], path: "/home/workspace/Docs/proof.pdf" },
        { type: "done" },
      ],
    });
    executedSteps.length = 0;
    const res = await start({ localName: "attachy" });
    const run = await settle(res.run.runId, ["done"]);
    expect(run.status).toBe("done");
    const attach = executedSteps.find((s) => s.type === "attach");
    expect(attach.path).toBe("/home/workspace/Docs/proof.pdf");
    expect(typeof (attach as any).dataB64 === "undefined" || attach.dataB64 === undefined).toBe(true);
    // The bytes rode the ACTION wrapper, not the persisted step.
    const st = await bus.runtime.sendMessage({ type: "RECIPE_STATUS", runId: run.runId });
    expect(st.run.recipe.steps[0].dataB64).toBeUndefined();
  });

  it("RECIPE_LIST reports the local library and any live run", async () => {
    const list = await bus.runtime.sendMessage({ type: "RECIPE_LIST" });
    expect(list.ok).toBe(true);
    expect(list.recipes.length).toBeGreaterThanOrEqual(2);
    expect(list.recipes.map((r: any) => r.name)).toContain("RTI filing");
  });

  it("invalid recipe JSON in the library refuses to start with the validation error", async () => {
    bus.storage.local._store.cobrowse_recipes.broken = { id: "rcp-broken", steps: "nope" };
    const res = await start({ localName: "broken" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid recipe");
  });
});

describe("recipe recorder — learn from a manual run (#220)", () => {
  it("arm → observe → stop learns a validated recipe; replay completes", async () => {
    // Arm.
    const armed = await bus.runtime.sendMessage({ type: "RECIPE_RECORD_START", chatId: "chat-rec", name: "learned-flow" });
    expect(armed.ok).toBe(true);
    expect(armed.name).toBe("learned-flow");
    // The content recorder's re-arm contract:
    const peek = await bus.runtime.sendMessage({ type: "RECIPE_RECORD_PEEK" });
    expect(peek.armed).toBe(true);

    // A second arm while live is refused.
    const again = await bus.runtime.sendMessage({ type: "RECIPE_RECORD_START", chatId: "chat-rec" });
    expect(again.ok).toBe(false);

    // Observations: a clean-page fill (value becomes a local param default)…
    await bus.runtime.sendMessage({
      type: "RECIPE_OBS",
      obs: { op: "fill", url: "https://fixture.example/form", title: "F", pageSensitive: false, cues: [{ strategy: "question", value: "Applicant name" }, { strategy: "selector", value: "#fullname" }], value: "LOCAL-ONLY-VALUE" },
    });
    // …and a sensitive-page event — the VALUE STAYS ON THE PAGE.
    await bus.runtime.sendMessage({
      type: "RECIPE_OBS",
      obs: { op: "fill", url: "https://fixture.example/checkout", title: "C", pageSensitive: true, cues: [{ strategy: "selector", value: "#cc" }], fieldSensitive: true },
    });

    // Stop: the LLM cleanup runs — its prompt must never carry values — and
    // fails (default mock returns {}), so the deterministic draft is kept.
    askResponder = null;
    const stop = await bus.runtime.sendMessage({ type: "RECIPE_RECORD_STOP" });
    expect(stop.ok).toBe(true);
    expect(stop.llmCleaned).toBe(false);
    expect(stop.steps).toBeGreaterThanOrEqual(3); // fill + human(checkpoint) + done
    const healAsks = fm.to("/zo/ask").filter((a: any) => String(a.body?.input || "").includes("## Recipe Draft"));
    expect(healAsks.length).toBe(1);
    const draftPrompt = String(healAsks[0].body.input);
    expect(draftPrompt).not.toContain("LOCAL-ONLY-VALUE");
    expect(draftPrompt).not.toContain("fieldSensitive");

    // Peek says disarmed.
    const after = await bus.runtime.sendMessage({ type: "RECIPE_RECORD_PEEK" });
    expect(after.armed).toBe(false);

    // The learned draft passed validation and is in the library — with the
    // sensitive page collapsed into exactly one human checkpoint.
    const lib = bus.storage.local._store.cobrowse_recipes["learned-flow"];
    expect(lib).toBeTruthy();
    const humans = lib.steps.filter((s: any) => s.type === "human");
    expect(humans).toHaveLength(1);
    expect(humans[0].resumeOn.url).toBe("RECIPE-AWAITING-MANUAL-STEP");
    expect(JSON.stringify(lib)).not.toContain("#cc"); // the sensitive field's own step was collapsed away

    // Replay: `!recipe run learned-flow` plays it — the human checkpoint
    // parks (its sentinel postcondition can never auto-verify), so force.
    executeBehavior = (action) => ({ ok: true, type: action.step?.type ?? action.type });
    captureBehavior = () => ({ url: "https://fixture.example/form", title: "F", formFields: [] });
    const res = await start({ localName: "learned-flow" });
    expect(res.ok).toBe(true);
    const waiting = await settle(res.run.runId, ["waiting_human"]);
    expect(waiting.status).toBe("waiting_human");
    const ok = await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: waiting.runId, force: true });
    expect(ok.ok).toBe(true);
    const done = await settle(waiting.runId, ["done"]);
    expect(done.status).toBe("done");
  });
});

describe("recipe generate-at-runtime fills (#228)", () => {
  it("generates the value when the step plays, fills it, and records evidence", async () => {
    bus.storage.local._store.cobrowse_recipes.geny = makeRecipe({
      id: "rcp-gen", name: "Generated",
      params: [{ name: "department", type: "string", required: true, question: "Which department?" }],
      steps: [
        {
          type: "fill", cues: [{ strategy: "question", value: "Applicant name" }],
          evidenceKey: "application_text", label: "Application text",
          generate: { prompt: "Draft an RTI application to {{department}}.", maxChars: 3000 },
        },
        { type: "done", message: "Filed with: {{application_text}}" },
      ],
    });
    executedSteps.length = 0;
    executeBehavior = (action) => ({ ok: true, type: action.step?.type ?? action.type });
    askResponder = () => jsonResponse({ output: "To the PIO, I request the annual report." });
    const res = await start({ localName: "geny" }, { department: "Urban Development" });
    expect(res.ok).toBe(true);
    const run = await settle(res.run.runId, ["done"]);
    expect(run.status).toBe("done");
    // The EXECUTED fill carried the generated value — the recipe's prompt did not.
    const fill = executedSteps.find((s) => s.type === "fill");
    expect(fill.value).toBe("To the PIO, I request the annual report.");
    expect(fill.generate).toBeUndefined();
    // Evidence recorded + interpolated into the done message.
    expect(run.evidence[0]).toMatchObject({ key: "application_text", value: "To the PIO, I request the annual report." });
    expect(run.stopReason).toBe("Filed with: To the PIO, I request the annual report.");
    // The one-shot prompt carried the substituted parameter.
    const genAsk = [...fm.to("/zo/ask")].reverse().find((a: any) => String(a.body?.input || "").includes("## Recipe Field Draft"));
    expect(String(genAsk.body.input)).toContain("Urban Development");
    expect(String(genAsk.body.input)).toContain("3000");
    askResponder = null;
  });

  it("contextFile source material rides along from the workspace", async () => {
    bus.storage.local._store.cobrowse_recipes.genfile = makeRecipe({
      id: "rcp-genf", name: "Generated from file",
      steps: [
        { type: "fill", cues: [{ strategy: "selector", value: "#fullname" }], generate: { prompt: "Summarize into the field.", contextFile: "/home/workspace/notes/source.md" } },
        { type: "done" },
      ],
    });
    executeBehavior = (action) => ({ ok: true, type: action.step?.type ?? action.type });
    askResponder = () => jsonResponse({ output: "summary text" });
    const res = await start({ localName: "genfile" });
    const run = await settle(res.run.runId, ["done"]);
    expect(run.status).toBe("done");
    // The workspace file's content rode along as fenced source material.
    const genAsk = [...fm.to("/zo/ask")].reverse().find((a: any) => String(a.body?.input || "").includes("## Recipe Field Draft"));
    const prompt = String(genAsk.body.input);
    expect(prompt).toContain("Source material from the workspace");
    expect(prompt).toContain("INTEGRATION-SOURCE-CONTENT");
    askResponder = null;
  });

  it("over-length output parks the run instead of clipping", async () => {
    bus.storage.local._store.cobrowse_recipes.genlong = makeRecipe({
      id: "rcp-genl", name: "Over cap",
      steps: [
        { type: "fill", cues: [{ strategy: "selector", value: "#x" }], generate: { prompt: "Write a lot", maxChars: 10 } },
        { type: "done" },
      ],
    });
    askResponder = () => jsonResponse({ output: "this is way more than ten characters long" });
    const res = await start({ localName: "genlong" });
    const blocked = await settle(res.run.runId, ["blocked"]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.stopReason).toContain("over the field cap");
    askResponder = null;
  });

  it("review:true parks with the draft; Fill uses the edited text; Discard blocks, resume regenerates", { timeout: 30_000 }, async () => {
    bus.storage.local._store.cobrowse_recipes.genrev = makeRecipe({
      id: "rcp-genr", name: "Reviewed",
      steps: [
        { type: "fill", cues: [{ strategy: "question", value: "Applicant name" }], evidenceKey: "draft", generate: { prompt: "Draft it", review: true } },
        { type: "done", message: "used {{draft}}" },
      ],
    });
    executedSteps.length = 0;
    executeBehavior = (action) => ({ ok: true, type: action.step?.type ?? action.type });
    let genCount = 0;
    askResponder = () => { genCount += 1; return jsonResponse({ output: `DRAFT ${genCount}` }); };
    const res = await start({ localName: "genrev" });
    const waiting = await settle(res.run.runId, ["waiting_human"]);
    expect(waiting.status).toBe("waiting_human");
    expect(waiting.pendingReview.text).toBe("DRAFT 1");

    // Edit + Fill — the edited text is what lands in the field.
    const ok = await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: waiting.runId, reviewText: "Edited by me" });
    expect(ok.ok).toBe(true);
    const done = await settle(waiting.runId, ["done"]);
    expect(done.status).toBe("done");
    const fill = executedSteps.find((s) => s.type === "fill");
    expect(fill.value).toBe("Edited by me");
    expect(done.evidence[0].value).toBe("Edited by me");

    // Discard path: regenerate → discard → blocked → resume regenerates fresh.
    const res2 = await start({ localName: "genrev" });
    const waiting2 = await settle(res2.run.runId, ["waiting_human"]);
    await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: waiting2.runId, discard: true });
    const blocked = await settle(waiting2.runId, ["blocked"]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.stopReason).toContain("discarded");
    const ok2 = await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: waiting2.runId });
    expect(ok2.ok).toBe(true);
    // A regenerated draft is review:true again — it parks for a fresh look.
    const waiting3 = await settle(waiting2.runId, ["waiting_human"]);
    expect(waiting3.pendingReview?.text).toBe("DRAFT 3");
    const ok3 = await bus.runtime.sendMessage({ type: "RECIPE_RESUME", runId: waiting2.runId, reviewText: "Final text" });
    expect(ok3.ok).toBe(true);
    const done2 = await settle(waiting2.runId, ["done"]);
    expect(done2.status).toBe("done");
    expect(genCount).toBe(3); // DRAFT 1, DRAFT 2 (discarded run), DRAFT 3 (regenerated)
    askResponder = null;
  });
});

describe("R2: workspace write-back (#256)", () => {
  it("refuses unknown names and unconfirmed overwrites; confirms into a loadable artifact", async () => {
    const none = await bus.runtime.sendMessage({ type: "RECIPE_SAVE", name: "ghost" });
    expect(none.ok).toBe(false);
    expect(String(none.error)).toContain("no local recipe");

    // The mock's read_file answers for every path → the probe reports the
    // target exists → the overwrite must refuse until confirmed.
    const refused = await bus.runtime.sendMessage({ type: "RECIPE_SAVE", name: "rti" });
    expect(refused.ok).toBe(false);
    expect(refused.exists).toBe(true);
    expect(refused.path).toBe("/home/workspace/recipes/rti-filing.json");

    // The phantom occupant the mock serves differs from the local copy → the
    // confirmed overwrite is content-drifted → patch bump on the way in.
    const saved = await bus.runtime.sendMessage({ type: "RECIPE_SAVE", name: "rti", confirm: true });
    expect(saved.ok).toBe(true);
    expect(saved.path).toBe("/home/workspace/recipes/rti-filing.json");
    expect(saved.version).toBe("1.0.1");
    expect(savedFiles.get(saved.path)).toContain('"name": "RTI filing"');

    // Traversal never reaches MCP.
    const evil = await bus.runtime.sendMessage({ type: "RECIPE_SAVE", name: "rti", path: "/home/other/x.json", confirm: true });
    expect(evil.ok).toBe(false);
    expect(String(evil.error)).toContain("must be inside");
  });

  it("an unchanged re-save does NOT bump; drifted content does; the artifact replays", async () => {
    captureBehavior = () => ({ url: "https://fixture.example/form", title: "F", formFields: [] });
    executeBehavior = (action) => ({ ok: true, type: action.step?.type ?? action.type });

    // Now the workspace file IS our last write — an unchanged re-save must
    // leave the version alone (no drift).
    const same = await bus.runtime.sendMessage({ type: "RECIPE_SAVE", name: "rti", confirm: true });
    expect(same.ok).toBe(true);
    expect(same.version).toBe("1.0.1");

    // Content drift → patch bump.
    bus.storage.local._store.cobrowse_recipes.rti.steps[1].value = "Grace";
    const saved2 = await bus.runtime.sendMessage({ type: "RECIPE_SAVE", name: "rti", confirm: true });
    expect(saved2.ok).toBe(true);
    expect(saved2.version).toBe("1.0.2");
    expect(savedFiles.get(saved2.path)).toContain("Grace");

    // Round-trip: run straight from the written workspace file.
    const res = await start({ workspacePath: "/home/workspace/recipes/rti-filing.json" });
    expect(res.ok).toBe(true);
    const done = await settle(res.run.runId, ["done"]);
    expect(done.status).toBe("done");
  });
});
