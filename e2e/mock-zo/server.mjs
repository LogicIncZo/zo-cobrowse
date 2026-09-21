// Mock Zo API + static fixture-site server for Playwright E2E.
//
// One process, two roles:
//   • http://127.0.0.1:3179/            — static e2e/fixtures/site (the "web pages")
//   • http://127.0.0.1:3179/zo/ask      — SSE streaming, scenario routed by
//     keywords in the prompt's `input` (fill/click/scroll/extract/error/…)
//   • /models/available, /personas/available, HEAD / — the endpoints the
//     extension's LIST_MODELS/LIST_PERSONAS/testConnection hit
//   • /__requests  — request recorder (GET list, DELETE clear) so specs can
//     assert on the exact prompts the extension sent
//
// No API key, no live network: the extension's zoApiUrl is seeded to this
// server via chrome.storage.local (host_permissions already include http://*/*).

import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const PORT = Number(process.env.E2E_PORT || 3179);
const SITE_DIR = resolve(new URL(".", import.meta.url).pathname, "../fixtures/site");
const requests = []; // {ts, method, url, body}
// R2 #256: in-memory workspace recipe files — write_file stores, read_file
// serves them back so save → run round-trips through the real transport.
// Control: GET /__recipes lists them, DELETE /__recipes resets.
const savedRecipes = new Map();
// #235: the virtual /home/workspace/Skills/zo-cobrowse/SKILL.md + a one-shot
// write_file failure arm (module scope — state must survive across requests).
let skillFile = null;
let skillWriteFail = false;

// ---- Lane E demo/coverage state ----
// Handoff runs are stateful across turns: a turn-1 prompt carries the
// "## Handoff Run" instructions (resets the counter); each continuation turn
// carries "[handoff-run continuation]" and gets the next scripted envelope.
let handoffTurn = 0;
// C1 (#289): the compose demo uses its own handoff sequence (a parked click +
// a navigation — the raw material of a composed draft) so it never collides
// with the 0.2.7 handoff demo's turns.
let composeTurn = 0;
// C2 (#290): the !recipe compose demo — Zo drives, the boundary refuses its
// fill (value park), the human fills, the session completes.
let compose2Turn = 0;
// The "flaky" scenario simulates transient network drops on the first N armed
// calls (socket destroy → retriable → the panel's Reconnecting banner shows
// "attempt 2 of 3", then "attempt 3 of 3"), then answers normally. Specs arm
// it via GET /__flaky/arm (N = 2).
let flakyArmed = 0;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SSE blocks for the real Zo protocol shape background.js parses. */
const textStart = (s) => `event: PartStartEvent\ndata: ${JSON.stringify({ index: 1, part: { part_kind: "text", content: s } })}\n\n`;
const textDelta = (s) => `event: PartDeltaEvent\ndata: ${JSON.stringify({ delta: { part_delta_kind: "text", content_delta: s } })}\n\n`;
const thinkingStart = (s) => `event: PartStartEvent\ndata: ${JSON.stringify({ index: 0, part: { part_kind: "thinking", content: s } })}\n\n`;
const completed = () => `event: completed\ndata: {}\n\n`;

/** Split prose into a few word-groups so streaming is visibly progressive.
 * Each group keeps its trailing space — concatenated deltas must reproduce
 * the original text exactly, like real token streams. */
function proseChunks(text) {
  const words = text.split(" ");
  const groups = [];
  for (let i = 0; i < words.length; i += 3) {
    const group = words.slice(i, i + 3).join(" ");
    groups.push(i + 3 < words.length ? group + " " : group);
  }
  return groups.length ? groups : [text];
}

async function streamSse(res, blocks, { delayMs = 60 } = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "access-control-allow-origin": "*",
    "x-conversation-id": "con_e2e-conv-1",
  });
  for (const block of blocks) {
    res.write(block);
    await sleep(delayMs);
  }
  res.end();
}

/** The user's actual query — the ## User Request section of the prompt (the
 * full prompt embeds page context + the action schema, whose "fill{...}"
 * text would otherwise match every action keyword). */
function userRequest(input) {
  const m = String(input || "").match(/## User Request\s*\n([^\n]*)/);
  return (m ? m[1] : String(input || "")).toLowerCase();
}

function pickScenario(input) {
  // A pull follow-up is NOT a new user turn — route by its auto-fetched
  // header, not the (absent) ## User Request section. The file pull (#52)
  // has its own follow-up (the generic one fills the form fixture).
  if (String(input || "").includes("## Auto-fetched: file")) return "pull-file-followup";
  if (String(input || "").includes("## Auto-fetched:")) return "pull-followup";
  // Lane E: handoff runs route on their markers, BEFORE user-keyword routing —
  // a handoff goal may legitimately contain words like "extract" or "click".
  // C2 (#290): compose sessions route on their own marker.
  if (String(input || "").includes("## Compose Run")) {
    compose2Turn = 1;
    composeTurn = 0;
    handoffTurn = 0;
    return "compose2-t1";
  }
  if (String(input || "").includes("## Handoff Run")) {
    handoffTurn = 1;
    if (String(input || "").includes("compose-e2e")) {
      composeTurn = 1;
      compose2Turn = 0;
      return "compose-t1";
    }
    composeTurn = 0; // a fresh non-compose handoff takes the counter back
    compose2Turn = 0;
    return "handoff-t1";
  }
  if (String(input || "").includes("[handoff-run continuation]")) {
    if (compose2Turn > 0) {
      compose2Turn += 1;
      return `compose2-t${Math.min(compose2Turn, 2)}`;
    }
    if (composeTurn > 0) {
      composeTurn += 1;
      return `compose-t${Math.min(composeTurn, 2)}`;
    }
    handoffTurn += 1;
    return `handoff-t${Math.min(handoffTurn, 3)}`;
  }
  if (String(input || "").includes("flaky")) return "flaky";
  // #342 Jev fast-path scenarios: a click whose text cue deliberately misses,
  // rescued (or not) by the Jev mock. (userRequest() lowercases — match that.)
  const q0 = userRequest(input);
  if (q0.includes("jev-pick-rescue")) return "jev-pick-rescue";
  if (q0.includes("jev-pick-lowconf")) return "jev-pick-lowconf";
  const q = userRequest(input);
  if (q.includes("schema")) return "pull-form";
  if (q.includes("workspace file")) return "pull-file";
  if (q.includes("code sample")) return "code-sample";
  if (q.includes("checkout")) return "fill-form";
  if (q.includes("classic form")) return "classic-form";
  if (q.includes("chunked")) return "fill-chunked";
  if (q.includes("then click")) return "fill-then-click";
  if (q.includes("application")) return "app-section-1";
  if (q.includes("continue") || q.includes("next section")) return "app-section-2";
  if (q.includes("slow fill")) return "fill-slow";
  if (q.includes("fill")) return "fill";
  if (q.includes("click")) return "click";
  if (q.includes("scroll")) return "scroll";
  if (q.includes("extract")) return "extract";
  if (q.includes("links")) return "links";
  if (q.includes("error") || q.includes("fail")) return "error";
  if (q.includes("unauthorized")) return "unauthorized";
  if (q.includes("navigate")) return "navigate";
  return "prose";
}

function q_slow(input) {
  return userRequest(input).includes("slow");
}

const server = http.createServer(async (req, res) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // ---- request recorder ----
  if (url.pathname === "/__requests") {
    if (req.method === "DELETE") {
      requests.length = 0;
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end('{"ok":true}');
    }
    res.writeHead(200, { "content-type": "application/json", ...cors });
    return res.end(JSON.stringify(requests));
  }
  // ---- flaky-network control (Lane D demo / reconnect-banner coverage) ----
  if (url.pathname === "/__flaky/arm") {
    flakyArmed = 2; // fail two attempts → the banner shows twice
    res.writeHead(200, { "content-type": "text/plain", ...cors });
    return res.end("armed");
  }
  if (url.pathname === "/__health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"ok":true}');
  }

  // ---- #235 protocol-skill workspace control ----
  // GET  /__skill          — the stored virtual SKILL.md (null when missing)
  // PUT  /__skill          — store a body as the installed copy (stale-seeding)
  // DELETE /__skill        — remove it (fresh-workspace state)
  // PUT  /__skill?mode=writefail — arm the next write_file to error once
  // (skillFile/skillWriteFail live at module scope, next to `requests`.)
  if (url.pathname === "/__recipes") {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify({ files: Object.fromEntries(savedRecipes) }));
    }
    if (req.method === "DELETE") {
      savedRecipes.clear();
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end('{"ok":true}');
    }
  }
  if (url.pathname === "/__skill") {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify({ content: skillFile, writeFail: skillWriteFail }));
    }
    if (req.method === "PUT") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (url.searchParams.get("mode") === "writefail") {
        skillWriteFail = true;
      } else {
        skillFile = Buffer.concat(chunks).toString("utf-8");
        skillWriteFail = false;
      }
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end('{"ok":true}');
    }
    if (req.method === "DELETE") {
      skillFile = null;
      skillWriteFail = false;
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end('{"ok":true}');
    }
  }

  // #25: no-auth model catalog — carries supports_images per model.
  if (url.pathname === "/models/catalog") {
    res.writeHead(200, { "content-type": "application/json", ...cors });
    return res.end(JSON.stringify({
      models: [
        { model_name: "mock-model", label: "Mock Model", vendor: "e2e", supports_images: false },
        { model_name: "mock-vision", label: "Mock Vision", vendor: "e2e", supports_images: true },
      ],
    }));
  }

  // #28: MCP server mock — the composer pickers' source (skills + files).
  // Mirrors the live server's shapes (verified 2026-08-18): JSON-RPC over
  // POST, initialize returns the session id header, tools/call `bash`
  // wraps stdout in a Python-repr CmdResult with __ZO_BEGIN__/__ZO_END__
  // markers around the payload.
  // Jev decide endpoint mock (0.3.4 Lane J) — the documented /v1/systemone
  // shape; deterministic high-confidence answers, request recorded.
  if (url.pathname === "/v1/systemone" && req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {}
    requests.push({ ts: Date.now(), method: "POST", url: "/v1/systemone", body });
    const answers = {};
    for (const [id, q] of Object.entries(body.questions || {})) {
      // #342 e2e: a goal/description tagged JEV-LOWCONF gets a deliberately
      // below-threshold answer so the fallback arm is testable.
      const low = JSON.stringify(q).includes("JEV-LOWCONF");
      if (q.type === "noul") answers[id] = { type: "noul", noul: low ? 0.2 : 0.97 };
      else if (q.type === "choice") {
        const keys = Object.keys(q.criteria || {});
        answers[id] = {
          type: "choice",
          choice: keys[0] ?? "",
          probabilities: { [keys[0] ?? ""]: low ? 0.3 : 0.97 },
          confidence: low ? 0.3 : 0.97,
        };
      } else if (q.type === "score") {
        answers[id] = { type: "score", score: 1, confidence: 0.95 };
      }
    }
    res.writeHead(200, { "content-type": "application/json", ...cors });
    return res.end(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: 42, output_tokens: 8 } }));
  }
  if (url.pathname === "/mcp" && req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {}
    requests.push({ ts: Date.now(), method: "POST", url: "/mcp", body });
    const json = (payload, headers = {}) => {
      res.writeHead(200, { "content-type": "application/json", ...cors, ...headers });
      res.end(JSON.stringify(payload));
    };
    if (body.method === "initialize") {
      return json(
        { jsonrpc: "2.0", id: body.id, result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "zo-tools", version: "1.0.0" },
        } },
        { "mcp-session-id": "e2e-mcp-session" },
      );
    }
    if (body.method === "notifications/initialized") {
      res.writeHead(202, cors);
      return res.end();
    }
    if (body.method === "tools/call" && body.params?.name === "read_file") {
      // #220: the recipes player loads its artifact from the workspace. Route
      // by path; every other path keeps the #52 notes fixture.
      const targetFile = String(body.params.arguments?.target_file || "");
      // #235: the protocol-skill install reads the virtual workspace copy —
      // missing → isError (mirrors the live read_failed shape).
      if (targetFile === "/home/workspace/Skills/zo-cobrowse/SKILL.md") {
        if (skillFile == null) {
          return json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "code: read_failed" }] } });
        }
        return json({ jsonrpc: "2.0", id: body.id, result: { isError: false, content: [{ type: "text", text: JSON.stringify([skillFile, `kind='file_ref' path='${targetFile}' media_type=None label=None`]) }] } });
      }
      // R2 #256: a file this server wrote wins over the fixtures — the
      // written artifact is what !recipe run must replay.
      if (savedRecipes.has(targetFile)) {
        const wrappedSaved = JSON.stringify([savedRecipes.get(targetFile), `kind='file_ref' path='${targetFile}' media_type=None label=None`]);
        return json({ jsonrpc: "2.0", id: body.id, result: { isError: false, content: [{ type: "text", text: wrappedSaved }] } });
      }
      if (targetFile.includes("notes/source.md")) {
        const wrappedNotes = JSON.stringify(["E2E-SOURCE-CONTENT: the draft notes behind the application.", "kind='file_ref' path='" + targetFile + "' media_type=None label=None"]);
        return json({ jsonrpc: "2.0", id: body.id, result: { isError: false, content: [{ type: "text", text: wrappedNotes }] } });
      }
      if (targetFile.includes("recipes/e2e-filing.json")) {
        const recipe = {
          id: "rcp-e2e",
          name: "E2E filing",
          version: "1.0.0",
          origin: targetFile,
          createdAt: 0,
          updatedAt: 0,
          params: [{ name: "applicant", type: "string", required: true, question: "Who is filing?" }],
          steps: [
            { type: "navigate", url: `http://127.0.0.1:${PORT}/form.html`, expectUrl: "form.html" },
            { type: "fill", cues: [{ strategy: "label", value: "Name" }, { strategy: "selector", value: "#name" }], value: "{{applicant}}" },
            { type: "navigate", url: `http://127.0.0.1:${PORT}/gateway.html`, expectUrl: "gateway.html" },
            { type: "human", title: "Pay ₹10 on the mock gateway", instructions: "Click Pay on the gateway page, then verify from the panel.", resumeOn: { url: "paid=1" } },
            { type: "extract", cues: [{ strategy: "selector", value: "#reg-number" }], evidenceKey: "registration", label: "Registration number" },
            { type: "done", message: "Filed {{applicant}} — registration {{registration}}" },
          ],
        };
        const wrappedRecipe = JSON.stringify([JSON.stringify(recipe), `kind='file_ref' path='${targetFile}' media_type=None label=None`]);
        return json({ jsonrpc: "2.0", id: body.id, result: { isError: false, content: [{ type: "text", text: wrappedRecipe }] } });
      }
      // #52 pull loop: mirrors the LIVE read_file shape (probe-read-file.ts) —
      // a JSON array of [fileText, fileRefDescriptor]; the background unwraps it.
      const wrapped = JSON.stringify([
        "e2e-file-content-52: the fixture workspace notes.",
        "kind='file_ref' path='/home/workspace/notes/e2e-summary.md' media_type=None label=None",
      ]);
      return json({ jsonrpc: "2.0", id: body.id, result: { isError: false, content: [{ type: "text", text: wrapped }] } });
    }
      // #235: the protocol-skill install writes here; a one-shot-error mode
      // exercises the ask-write fallback.
      if (body.method === "tools/call" && body.params?.name === "write_file") {
        const targetFile = String(body.params.arguments?.target_file || "");
        // R3 #257: skill-export bundles land here too — EXCEPT the exact
        // #235 protocol-skill path, whose dedicated branch below carries the
        // writefail arm the install tests exercise.
        if (targetFile.startsWith("/home/workspace/Skills/") && targetFile !== "/home/workspace/Skills/zo-cobrowse/SKILL.md") {
          savedRecipes.set(targetFile, String(body.params.arguments?.content || ""));
          return json({ jsonrpc: "2.0", id: body.id, result: { isError: false, content: [{ type: "text", text: "ok" }] } });
        }
        // R2 #256: recipe write-back targets the in-memory workspace store.
        if (targetFile.startsWith("/home/workspace/recipes/")) {
          savedRecipes.set(targetFile, String(body.params.arguments?.content || ""));
          return json({ jsonrpc: "2.0", id: body.id, result: { isError: false, content: [{ type: "text", text: "ok" }] } });
        }
        if (targetFile === "/home/workspace/Skills/zo-cobrowse/SKILL.md" && !skillWriteFail) {
          skillFile = String(body.params.arguments?.content || "");
          skillWriteFail = false;
          return json({ jsonrpc: "2.0", id: body.id, result: { isError: false, content: [{ type: "text", text: "ok" }] } });
        }
        return json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "write_file unavailable" }] } });
      }
      if (body.method === "tools/call" && body.params?.name === "bash") {
      const cmd = String(body.params.arguments?.cmd || "");
      const bash = (stdout) => `CmdResult(stdout='__ZO_BEGIN__\\n${stdout}\\n__ZO_END__\\n', stderr='', returncode=0)`;
      if (cmd.includes("SKILL.md")) {
        const skillsOut = [
          "##SKILL /home/workspace/Skills/websh",
          "---",
          "name: websh",
          "description: A shell for the web.",
          "---",
          "",
          "##SKILL /home/workspace/Skills/e2e-skill",
          "---",
          "name: e2e-skill",
          "description: Fixture skill for the picker e2e.",
          "---",
        ].join("\\n");
        return json({ jsonrpc: "2.0", id: body.id, result: { isError: false, content: [{ type: "text", text: bash(skillsOut) }] } });
      }
      if (cmd.includes("ls -1F")) {
        const listing = cmd.includes("/home/workspace/Skills") ? "e2e-skill/\\nREADME.md" : "Skills/\\nAGENTS.md";
        return json({ jsonrpc: "2.0", id: body.id, result: { isError: false, content: [{ type: "text", text: bash(listing) }] } });
      }
      return json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "unexpected command" }] } });
    }
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
  }

  // ---- mock Zo API ----
  if (url.pathname === "/models/available" || url.pathname === "/personas/available") {
    const isModels = url.pathname.includes("models");
    res.writeHead(200, { "content-type": "application/json", ...cors });
    return res.end(
      JSON.stringify(
        isModels
          ? { models: [{ model_name: "mock-model", label: "Mock Model", vendor: "e2e" }] }
          : { personas: [{ id: "mock-persona", name: "Mock Persona" }] },
      ),
    );
  }

  if (url.pathname === "/zo/ask" && req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString("utf-8");
    let body = {};
    try {
      body = JSON.parse(bodyText);
    } catch {}
    requests.push({ ts: Date.now(), method: "POST", url: "/zo/ask", body });
    // #235: the one-shot agent-write fallback posts the skill content with the
    // save-page CONTENT START fence — a non-streaming JSON reply, and the
    // virtual workspace file actually stores it (the real agent would write).
    if (String(body.input || "").includes("---CONTENT START---")) {
      const m = String(body.input).match(/---CONTENT START---\n([\s\S]*?)\n---CONTENT END---/);
      if (m && String(body.input).includes("/home/workspace/Skills/zo-cobrowse/SKILL.md")) {
        skillFile = m[1];
        res.writeHead(200, { "content-type": "application/json", ...cors });
        return res.end(JSON.stringify({ output: "written" }));
      }
    }

    // Write-assist one-shot (feature/textarea-fill): the in-page widget's
    // #220 recorder: the LLM cleanup pass for a recorded draft is a
    // non-streaming one-shot (routes on its stable prompt marker). Returns a
    // cleaned, parameterized recipe whose fill targets the fixture form.
    if (String(body.input || "").includes("## Recipe Draft")) {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify({
        output: JSON.stringify({
          params: [{ name: "applicant_name", type: "string", required: true, question: "Who is the applicant?" }],
          steps: [
            { type: "navigate", url: `http://127.0.0.1:${PORT}/form.html`, expectUrl: "form.html" },
            { type: "fill", cues: [{ strategy: "label", value: "Name" }, { strategy: "selector", value: "#name" }], value: "{{applicant_name}}" },
            { type: "done", message: "Learned flow complete for {{applicant_name}}" },
          ],
          note: "renamed the param, pinned the cues",
        }),
      }));
    }
    // C2 (#290): the compose demo's cleanup — the human-filled value lands as
    // a defaultless param (values are human-only on replay too here: the e2e
    // rehearsal answers the params card).
    if (String(body.input || "").includes("## Composed Recipe Draft") && String(body.input || "").includes("compose2 e2e")) {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify({
        output: JSON.stringify({
          params: [{ name: "visitor_name", type: "string", required: true, question: "Who is visiting?" }],
          steps: [
            { type: "navigate", url: `http://127.0.0.1:${PORT}/form.html`, expectUrl: "form.html" },
            { type: "fill", cues: [{ strategy: "label", value: "Name" }, { strategy: "selector", value: "#name" }], value: "{{visitor_name}}" },
            { type: "done", message: "Composed demo complete" },
          ],
          note: "renamed the param, pinned the cues",
        }),
      }));
    }
    // C1 (#289): the composed-draft cleanup pass is a non-streaming one-shot
    // (routes on its stable marker) — returns a cleaned draft whose checkpoint
    // carries a form.html postcondition so the e2e rehearsal can verify.
    if (String(body.input || "").includes("## Composed Recipe Draft")) {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify({
        output: JSON.stringify({
          params: [],
          steps: [
            { type: "human", title: "Make the final click", instructions: "The buy click stays yours — do it, then continue.", resumeOn: { url: "form.html" } },
            { type: "navigate", url: `http://127.0.0.1:${PORT}/form.html`, expectUrl: "form.html" },
            { type: "done", message: "Composed demo complete" },
          ],
          note: "pruned the retry, pinned the checkpoint",
        }),
      }));
    }
    // ENHANCE_TEXT handler calls /zo/ask NON-streaming and parses JSON
    // ({output}), so reply with a plain JSON body — not SSE. Routed on the
    // stable write-assist marker baked into the enhance prompt. The reply
    // follows the prompt's tag protocol with narration outside the tags —
    // the widget must preview ONLY the tag content.
    // Write-assist one-shot routes FIRST (it is also non-streaming): its
    // reply follows the <write-assist> tag protocol the widget parses.
    if (String(body.input || "").includes("write-assist")) {
      // #53 streaming popover: the port path posts stream:true and reads real
      // SSE — narration outside the tags streams too (the popover must drop
      // it); the completed event echoes the thread for the follow-up chips.
      if (body.stream) {
        const revised = String(body.input || "").includes("FOLLOW-UP iteration")
          ? "SHORTENED: led the DuckDB migration; p95 cut in half."
          : "I led the migration of 40 dashboards to DuckDB, unifying our analytics stack and cutting p95 query times roughly in half.";
        const blocks = [];
        blocks.push(`event: PartStartEvent\ndata: ${JSON.stringify({ index: 1, part: { part_kind: "text", content: "Thinking out loud about the rewrite. " } })}\n`);
        for (const piece of ["<write-assist>", revised, "</write-assist>"]) {
          blocks.push(`event: PartDeltaEvent\ndata: ${JSON.stringify({ index: 1, delta: { part_delta_kind: "text", content_delta: piece } })}\n`);
        }
        blocks.push(`event: completed\ndata: ${JSON.stringify({ status: "succeeded", conversation_id: "e2e-wa-thread" })}\n`);
        return streamSse(res, blocks, { delayMs: 40 });
      }
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify({
        output: "Let me quickly ground this in the data model before expanding.\n" +
          "<write-assist>" +
          "I led the migration of 40 dashboards to DuckDB, unifying our analytics stack and cutting p95 query times roughly in half." +
          "</write-assist>",
        conversation_id: "e2e-enhance-conv",
      }));
    }
    // Other non-streaming asks (!save / SAVE_CONVERSATION) are plain JSON on
    // the live server — SSE is opt-in via stream:true.
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify({ output: "mock answer", conversation_id: "e2e-nostream-conv" }));
    }

    const scenario = pickScenario(body.input);
    if (scenario === "jev-pick-rescue" || scenario === "jev-pick-lowconf") {
      // #342: a click whose text cue matches NOTHING on the fixture page —
      // the executor reports cueMiss + candidates, and the Jev fast path
      // (mocked /v1/systemone) either rescues it or falls back by confidence.
      const text = scenario === "jev-pick-lowconf" ? "JEV-LOWCONF Buy now" : "Buy now";
      const env = JSON.stringify({ actions: [
        { type: "click", text },
        { type: "done", response: "fast path exercised" },
      ]});
      return streamSse(res, [textStart(env), completed()], { delayMs: 100 });
    }
    if (scenario === "handoff-t1" || scenario === "handoff-t2") {
      // Simulated thinking time — keeps the recorded run watchable.
      await sleep(1100);
    }
    if (scenario === "handoff-t1") {
      // Turn 1 tempts the boundary (a click — parked under the readonly
      // boundary) and navigates the driven tab to the next fixture page.
      const env = JSON.stringify({ actions: [
        { type: "click", selector: "#buy-now" },
        { type: "navigate", url: `http://127.0.0.1:${PORT}/form.html` },
      ]});
      return streamSse(res, [
        thinkingStart("Scanning the page for pricing signals and planning the route…"),
        textStart(env),
        completed(),
      ], { delayMs: 150 });
    }
    if (scenario === "handoff-t2") {
      const env = JSON.stringify({ actions: [
        { type: "navigate", url: `http://127.0.0.1:${PORT}/checkout.html` },
      ]});
      return streamSse(res, [
        thinkingStart("Continuing: moving to the checkout page to read its plan rows…"),
        textStart(env),
        completed(),
      ], { delayMs: 150 });
    }
    if (scenario === "handoff-t3") {
      const env = JSON.stringify({ actions: [
        { type: "done", response: "## Pricing digest\n\nCompared across the fixture pages (Pro $29/mo, Team $79/mo, Enterprise custom): **Pro** is the value pick for solo use; **Team** wins at 3+ seats. The click on **Buy now** was parked for you — checkout stays a human decision." },
      ]});
      return streamSse(res, [textStart(env), completed()], { delayMs: 120 });
    }
    if (scenario === "compose-t1") {
      // C1 (#289) demo turn 1: the click is PARKED (readonly boundary) and the
      // tab moves to form.html — exactly the obs a composed draft needs (the
      // park becomes the human checkpoint, the navigation a step).
      const env = JSON.stringify({ actions: [
        { type: "click", selector: "#buy-now" },
        { type: "navigate", url: `http://127.0.0.1:${PORT}/form.html` },
      ]});
      return streamSse(res, [
        thinkingStart("Planning the route: check the offer, then move to the form."),
        textStart(env),
        completed(),
      ], { delayMs: 120 });
    }
    if (scenario === "compose-t2") {
      const env = JSON.stringify({ actions: [
        { type: "done", response: "Walked the flow: the buy click is yours by design; the form page is the next stop." },
      ]});
      return streamSse(res, [textStart(env), completed()], { delayMs: 100 });
    }
    if (scenario === "compose2-t1") {
      // C2 demo turn 1: navigate + ATTEMPT the fill — the compose boundary
      // refuses the fill (value park), the human fills the page instead.
      const env = JSON.stringify({ actions: [
        { type: "navigate", url: `http://127.0.0.1:${PORT}/form.html` },
        { type: "fill", selector: "#name" },
      ]});
      return streamSse(res, [textStart(env), completed()], { delayMs: 80 });
    }
    if (scenario === "compose2-t2") {
      const env = JSON.stringify({ actions: [
        { type: "done", response: "Walked the demo form flow end to end: navigated, the human filled the field." },
      ]});
      return streamSse(res, [textStart(env), completed()], { delayMs: 80 });
    }
    if (scenario === "flaky") {
      if (flakyArmed <= 0) {
        // Hold briefly before answering so the Reconnecting banner (shown
        // during the retry backoff) stays watchable.
        await sleep(1800);
        return streamSse(res, [textStart("Steady answer — the network behaved."), completed()], { delayMs: 50 });
      }
      flakyArmed -= 1;
      // Simulate a mid-flight network drop: destroy the socket so the fetch
      // throws (retriable) → the background backs off, shows the
      // "➳ Reconnecting…" banner, and retries into this handler (now disarmed).
      res.destroy();
      return;
    }
    if (scenario === "code-sample") {
      // UX-polish spec: a prose answer containing a fenced code block (the
      // sidepanel renders <pre><code> with a Copy button at STREAM_DONE).
      const text = "Here is a sample:\n```js\nconsole.log('hello zo');\n```\nThat is the code.";
      return streamSse(res, [textStart(text), completed()], { delayMs: 40 });
    }
    if (scenario === "pull-form") {
      // Zo asks for the complete form schema before acting (#24 pull loop).
      const envelope = JSON.stringify({
        reasoning: "I need the complete form schema first.",
        actions: [{ type: "get_form" }],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "pull-file") {
      // #52: Zo asks for a referenced workspace file before answering.
      const envelope = JSON.stringify({
        reasoning: "I need the workspace notes first.",
        actions: [{ type: "read_file", path: "/home/workspace/notes/e2e-summary.md" }],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "pull-file-followup") {
      // The auto-fetched file content arrived — answer from it.
      const envelope = JSON.stringify({
        reasoning: "File content received.",
        actions: [
          { type: "done", response: "Your workspace notes say: e2e-file-content-52 (summarized)." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "pull-followup") {
      // The auto-injected schema arrived — now act on it.
      const envelope = JSON.stringify({
        reasoning: "Schema received; filling the name field.",
        actions: [
          { type: "fill", selector: "#name", value: "Pulled E2E" },
          { type: "done", response: "Filled using the pulled form schema." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "fill-chunked") {
      // Real Zo streams the action envelope as MANY small text deltas (the
      // e2e textStart blocks are single-chunk, which hid a leak: the panel
      // tested each delta for action-JSON, and every delta after the first
      // rendered as chat prose). Split mid-string like a real token stream.
      const envelope = JSON.stringify({
        actions: [
          { type: "fill", selector: "#name", value: "Chunked E2E" },
          { type: "fill", selector: "#email", value: "chunked@example.test" },
          { type: "done", response: "Filled the two visible fields — review them and submit when ready." },
        ],
      });
      const step = 14;
      const deltas = [];
      for (let i = 0; i < envelope.length; i += step) deltas.push(envelope.slice(i, i + step));
      return streamSse(res, [textStart(deltas[0]), ...deltas.slice(1).map(textDelta), completed()], { delayMs: 15 });
    }
    if (scenario === "fill-then-click") {
      // The user rule: Zo fills, and then MUST NOT click the form's action
      // button. The model drifts here on purpose — the extension's hard
      // backstop has to block the #submit-btn click (a plain type=button on
      // a benign page; the sensitive-page gate does not apply).
      const envelope = JSON.stringify({
        actions: [
          { type: "fill", selector: "#name", value: "Click Block" },
          { type: "click", selector: "#submit-btn" },
          { type: "done", response: "Filled the name field." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "classic-form") {
      // "Any form" hardening round: a RoboForm-shaped classic form. The mock
      // streams the EXACT broken envelope Zo emitted live — key-first
      // {"fill":{...}} actions, CSS \NN escapes for digit-leading names, and
      // UNESCAPED double quotes inside the selector strings (invalid JSON).
      // The extension must repair it, park it (password + card fields), and
      // fill only after confirm. NOTE: hand-built string, NOT JSON.stringify —
      // the invalidity is the scenario.
      const broken =
        '{"actions": [\n' +
        '  {"fill": {"selector": "input[name="\\\\30 1___title"]", "value": "Mr."}},\n' +
        '  {"fill": {"selector": "input[name="\\\\30 2frstname"]", "value": "Test"}},\n' +
        '  {"fill": {"selector": "input[name="\\\\30 4lastname"]", "value": "User"}},\n' +
        '  {"fill": {"selector": "input[name="\\\\33 0_user_id"]", "value": "testuser01"}},\n' +
        '  {"fill": {"selector": "input[name="\\\\33 1password"]", "value": "T3st-Passw0rd!"}},\n' +
        '  {"fill": {"selector": "select[name="\\\\34 0cc__type"]", "value": "Visa (Preferred)"}},\n' +
        '  {"fill": {"selector": "input[name="\\\\34 1ccnumber"]", "value": "4111111111111111"}},\n' +
        '  {"fill": {"selector": "select[name="\\\\34 2ccexp_mm"]", "value": "12"}},\n' +
        '  {"fill": {"selector": "input[name="\\\\34 3cvc"]", "value": "123"}},\n' +
        '  {"done": {"response": "Filled the fields with test data — review and submit when ready."}}\n' +
        ']}';
      return streamSse(res, [textStart(broken), completed()], { delayMs: 40 });
    }
    if (scenario === "app-section-1") {
      // "Any form" round: builder-style form — target by QUESTION text (the
      // fields share one placeholder); fill only the VISIBLE section, then
      // done so the user reviews + advances (co-browse pacing).
      const envelope = JSON.stringify({
        reasoning: "This is a one-question-per-screen form; I'll fill the visible section and let the user review it.",
        actions: [
          { type: "fill_form", values: [
            { target: "First name", value: "Ada Lovelace" },
            { target: "Work email", value: "ada@example.dev" },
          ] },
          { type: "done", response: "Filled the visible section — review it and press OK when ready, then ask me to continue." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "app-section-2") {
      const envelope = JSON.stringify({
        reasoning: "The user advanced to section 2; filling the now-visible section.",
        actions: [
          { type: "fill_form", values: [
            { target: "Share your website", value: "https://ada.example.dev" },
            { target: "Tell us about you", value: "I build browser tooling." },
          ] },
          { type: "done", response: "Section 2 filled — review and submit when ready." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "fill-form") {
      // #26: batch fill by human-facing cues; password/card values omitted by
      // the prompt rule — the review card lists them as "left for you".
      const envelope = JSON.stringify({
        reasoning: "I will batch-fill the checkout form; secrets stay with the user.",
        actions: [
          { type: "fill_form", values: [
            { target: "Email", value: "e2e@example.com" },
            { target: "Password", value: "" },
            { target: "Card number", value: "" },
          ] },
          { type: "done", response: "Filled what I could — review the card." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "fill") {
      const envelope = JSON.stringify({
        reasoning: "Filling the form fields. The user will review and submit.",
        actions: [
          { type: "fill", selector: "#name", value: "E2E Tester" },
          { type: "fill", selector: "#email", value: "e2e@example.test" },
          { type: "fill", selector: "#plan", value: "pro" },
          { type: "done", response: "Form filled — review it and submit when ready." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "click") {
      const envelope = JSON.stringify({
        reasoning: "Clicking the thing.",
        actions: [
          { type: "click", selector: "#action-btn" },
          { type: "done", response: "Clicked the button." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "scroll") {
      const envelope = JSON.stringify({
        reasoning: "Scrolling down.",
        actions: [
          { type: "scroll", direction: "down", amount: 1200 },
          { type: "done", response: "Scrolled down." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "extract") {
      const envelope = JSON.stringify({
        reasoning: "Extracting the status text.",
        actions: [
          { type: "extract", selector: "#status-card" },
          { type: "done", response: "Extracted." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "navigate") {
      const envelope = JSON.stringify({
        reasoning: "Navigating to the form page.",
        actions: [
          { type: "navigate", url: `http://127.0.0.1:${PORT}/form.html` },
          { type: "done", response: "Navigated." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 40 });
    }
    if (scenario === "links") {
      // #27: a research-style prose answer full of links — triggers the
      // link-chips card + "Open all" in the sidepanel. "slow" stretches the
      // delays so the demo recording shows visibly progressive streaming.
      const text =
        "Here are the best sources on the fixture site:\n\n" +
        `- [Fixture home](http://127.0.0.1:${PORT}/)\n` +
        `- [The demo form](http://127.0.0.1:${PORT}/form.html)\n` +
        `- [A long article](http://127.0.0.1:${PORT}/long.html)\n`;
      return streamSse(
        res,
        [thinkingStart("Searching the fixture site… "), ...proseChunks(text).map(textDelta), completed()],
        { delayMs: q_slow(body.input) ? 350 : 60 },
      );
    }
    if (scenario === "unauthorized") {
      // 401 — non-retriable auth failure. The panel must render an error card
      // (not hang, not retry-loop).
      res.writeHead(401, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify({ error: "invalid token" }));
    }
    if (scenario === "fill-slow") {
      // Exploratory: a fill envelope that takes ~2s to finish streaming, so
      // STREAM_DONE lands well after the panel switched to another chat.
      const envelope = JSON.stringify({
        actions: [
          { type: "fill", selector: "#name", value: "Background Fill" },
          { type: "done", response: "Filled the name field." },
        ],
      });
      return streamSse(res, [textStart(envelope), completed()], { delayMs: 700 });
    }
    if (scenario === "error") {
      res.writeHead(200, { "content-type": "text/event-stream", ...cors });
      res.write(`event: Error\ndata: ${JSON.stringify({ message: "Mock upstream failure" })}\n\n`);
      return res.end();
    }

    // default: prose with thinking + progressive text deltas ("slow" stretches
    // the delays so mid-stream UI states are assertable)
    const slow = q_slow(body.input);
    return streamSse(
      res,
      [
        thinkingStart("Let me look at the page. "),
        ...proseChunks("This is the mock answer about the fixture page.").map(textDelta),
        completed(),
      ],
      { delayMs: slow ? 900 : 60 },
    );
  }

  // ---- static fixture site ----
  let filePath = join(SITE_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  if (!existsSync(filePath)) {
    res.writeHead(404, cors);
    return res.end("not found");
  }
  const stat = statSync(filePath);
  res.writeHead(200, {
    "content-type": MIME[extname(filePath)] || "application/octet-stream",
    "content-length": stat.size,
    ...cors,
  });
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[e2e] mock zo + fixture site on http://127.0.0.1:${PORT}`);
});
