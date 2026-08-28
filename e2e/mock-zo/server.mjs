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
    "x-conversation-id": "e2e-conv-1",
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
  // header, not the (absent) ## User Request section.
  if (String(input || "").includes("## Auto-fetched:")) return "pull-followup";
  const q = userRequest(input);
  if (q.includes("schema")) return "pull-form";
  if (q.includes("checkout")) return "fill-form";
  if (q.includes("classic form")) return "classic-form";
  if (q.includes("chunked")) return "fill-chunked";
  if (q.includes("then click")) return "fill-then-click";
  if (q.includes("application")) return "app-section-1";
  if (q.includes("continue") || q.includes("next section")) return "app-section-2";
  if (q.includes("fill")) return "fill";
  if (q.includes("click")) return "click";
  if (q.includes("scroll")) return "scroll";
  if (q.includes("extract")) return "extract";
  if (q.includes("links")) return "links";
  if (q.includes("error") || q.includes("fail")) return "error";
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
  if (url.pathname === "/__health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"ok":true}');
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

    // Write-assist one-shot (feature/textarea-fill): the in-page widget's
    // ENHANCE_TEXT handler calls /zo/ask NON-streaming and parses JSON
    // ({output}), so reply with a plain JSON body — not SSE. Routed on the
    // stable write-assist marker baked into the enhance prompt.
    if (String(body.input || "").includes("write-assist")) {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify({
        output: "I led the migration of 40 dashboards to DuckDB, unifying our analytics stack and cutting p95 query times roughly in half.",
        conversation_id: "e2e-enhance-conv",
      }));
    }

    const scenario = pickScenario(body.input);
    if (scenario === "pull-form") {
      // Zo asks for the complete form schema before acting (#24 pull loop).
      const envelope = JSON.stringify({
        reasoning: "I need the complete form schema first.",
        actions: [{ type: "get_form" }],
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
