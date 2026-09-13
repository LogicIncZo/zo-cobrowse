import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import * as vm from "node:vm";
import { normalizeActions } from "../extension/lib/modes.js";

const SIDEPANEL_PATH = resolve(import.meta.dir, "../extension/sidepanel.js");
const code = readFileSync(SIDEPANEL_PATH, "utf-8");

describe("sidepanel.js", () => {
  it("is valid JavaScript (ESM module)", () => {
    // sidepanel.js is now an ES module (uses import). Validate via Bun's transpiler,
    // which accepts import/export and throws on syntax errors.
    expect(() => new Bun.Transpiler().transformSync(code)).not.toThrow();
  });

  it("has history persistence (MAX_HISTORY, loadConversations, saveConversations)", () => {
    expect(code).toContain("MAX_HISTORY");
    expect(code).toContain("loadConversations");
    expect(code).toContain("saveConversations");
    expect(code).toContain("STORAGE_CONVERSATIONS_KEY");
    expect(code).toContain("chrome.storage.local");
  });

  it("has new chat button and startNewConversation", () => {
    expect(code).toContain("newChatBtn");
    expect(code).toContain("startNewConversation");
    expect(code).toContain("NEW_CONVERSATION");
  });

  it("restores conversations on init", () => {
    expect(code).toContain("loadConversations()");
    expect(code).toContain("migrateOldFormat()");
    expect(code).toContain("fetchModelsAndPersonas()");
  });
});

describe("sidepanel model/persona selectors", () => {
  it("has model-select and persona-select elements in HTML", () => {
    const htmlPath = resolve(import.meta.dir, "../extension/sidepanel.html");
    const html = readFileSync(htmlPath, "utf-8");
    expect(html).toContain('id="model-select"');
    expect(html).toContain('id="persona-select"');
  });  it("fetches models and personas from background", () => {
    expect(code).toContain('LIST_MODELS');
    expect(code).toContain('LIST_PERSONAS');
    expect(code).toContain('config.selectedModel');
    expect(code).toContain('config.selectedPersona');
  });

  it("passes modelName and personaId in ASK_ZO", () => {
    expect(code).toContain('modelName:');
    expect(code).toContain('personaId:');
  });

  it("attaches effectiveTier to every ASK_ZO payload (opt-in DOM / send-once)", () => {
    // The context policy (lib/context-policy.js) decides effectiveTier per
    // turn; both the streaming port post and the non-streaming fallback must
    // carry it so buildPrompt can thin the prompt.
    expect(code).toMatch(/import\s*\{[^}]*\bdecideTurn\b[^}]*\}\s*from\s*['"]\.\/lib\/context-policy\.js['"]/);
    expect(code).toContain('decideTurn(');
    expect(code).toContain('effectiveTier,');
    // Both payload sites (stream post + fallback) include it.
    expect((code.match(/effectiveTier,/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("renders a live prompt inspector using the shared prompt lib", () => {
    const html = readFileSync(resolve(import.meta.dir, "../extension/sidepanel.html"), "utf-8");
    expect(html).toContain('id="prompt-inspector"');
    expect(html).toContain('id="prompt-preview"');
    // Computed client-side from lib/prompt.js (single source of truth).
    expect(code).toMatch(/import\s*\{[^}]*\bdescribePrompt\b[^}]*\}\s*from\s*['"]\.\/lib\/prompt\.js['"]/);
    expect(code).toContain("function renderPromptInspector");
    expect(code).toContain("schedulePromptInspector");
  });

  it("captures at the OVERRIDDEN mode tier (Settings contextTier raises actually capture)", () => {
    // Regression: refreshPageContext must resolve the Mode with modeOverrides —
    // otherwise raising a built-in's contextTier in Settings never captures the
    // higher-tier fields (effectiveTier can only thin, never widen).
    expect(code).toMatch(
      /const mode = resolveMode\(activeModeId, customModes, modeOverrides\);\s*\n\s*const resp = await chrome\.runtime\.sendMessage\(\{ type: 'GET_PAGE_CONTEXT'/
    );
  });

  it("inspector previews mode-switching bangs (!summarize etc.) with the turn's real Mode", () => {
    // Regression: the preview must honor bang.mode (tempMode) exactly like
    // sendQuery, else !summarize previews the cobrowse prompt while the send
    // uses the summarize Mode.
    expect(code).toContain("bangModeId || activeModeId");
  });

  it("persists selections to chrome.storage.sync", () => {
    expect(code).toContain('zoModel');
    expect(code).toContain('zoPersonaId');
    expect(code).toContain('chrome.storage.sync');
  });

  it("maps model_name/label from API response", () => {
    expect(code).toContain('m.model_name');
    expect(code).toContain('m.label');
  });
});

describe("Zo-native message rendering", () => {
  // Guards the Phase-2 changes: user messages render markdown (not plain
  // textContent) so composer-shell prose + mention pills work, and a
  // page-context mention pill is attached on the send path.
  it("addMessageDOM renders markdown for user messages too (Zo composer prose)", () => {
    // Previously user bodies used textContent; now all roles go through
    // markdownToHtml. Assert the unified branch + that no role is left
    // on the plain-text path.
    expect(code).toMatch(/body\.innerHTML = markdownToHtml\(text\)/);
    expect(code).not.toMatch(/role === 'assistant' \|\| role === 'system' \|\| role === 'thinking'/);
  });

  it("defines appendMentionPill (Zo file-mention badge helper)", () => {
    expect(code).toContain("function appendMentionPill");
    expect(code).toContain("msg-mention");
    expect(code).toContain("msg-mention-label");
  });

  it("attaches a page-context mention pill on the main send path", () => {
    expect(code).toContain("currentContext && (currentContext.title || currentContext.url)");
    expect(code).toContain("appendMentionPill(userBody");
  });

  it("suppresses raw action-JSON during streaming (shows a placeholder)", () => {
    // Chronological feed: raw action-JSON is no longer a separate concern —
    // reasoning tokens stream as .msg-stream-thought, tool cards as
    // .msg-stream-tool-card, and answer tokens as markdown. The old
    // isActionJson / msg-streaming-actions placeholder was removed.
    // This test now just ensures the chronological feed classes exist.
    expect(code).toContain("msg-stream-thought");
    expect(code).toContain("msg-stream-tool-card");
  });

  it("never falls back to the raw action-JSON as the final response text", () => {
    // STREAM_DONE must not surface the streamed JSON as the assistant body
    // when done.response is absent: skip the fullText fallback when actions
    // are present.
    expect(code).toContain("hasActions");
    expect(code).toMatch(/hasActions \? '' : safeText\(msg\.fullText\)/);
  });
});

describe("sidepanel history view", () => {
  it("has history button and view elements in HTML", () => {
    const htmlPath = resolve(import.meta.dir, "../extension/sidepanel.html");
    const html = readFileSync(htmlPath, "utf-8");
    expect(html).toContain('id="history-btn"');
    expect(html).toContain('id="chat-view"');
    expect(html).toContain('id="history-view"');
    expect(html).toContain('id="history-list"');
    expect(html).toContain('id="back-to-chat-btn"');
  });

  it("has multi-conversation storage functions", () => {
    expect(code).toContain("switchToConversation");
    expect(code).toContain("deleteConversation");
    expect(code).toContain("renderHistoryView");
    expect(code).toContain("listConversationSummaries");
    expect(code).toContain("createNewConversation");
    expect(code).toContain("migrateOldFormat");
    expect(code).toContain("OLD_STORAGE_KEY");
  });

  it("has conversation grouping by date", () => {
    expect(code).toContain("groupByDate");
    expect(code).toContain("formatTime");
    expect(code).toContain("'Today'");
    expect(code).toContain("'Yesterday'");
  });
});

describe("sidepanel chat tabs", () => {
  it("has the chat tab bar element in HTML", () => {
    const htmlPath = resolve(import.meta.dir, "../extension/sidepanel.html");
    const html = readFileSync(htmlPath, "utf-8");
    expect(html).toContain('id="chat-tabs"');
    expect(html).toContain('role="tablist"');
  });

  it("persists the open-tab set alongside the conversation map", () => {
    expect(code).toContain("STORAGE_TABS_KEY");
    expect(code).toMatch(/\[STORAGE_TABS_KEY\]: tabsState\.openIds/);
  });

  it("opens a tab for every new/migrated conversation", () => {
    expect(code).toMatch(/tabsState = openChatTab\(tabsState, id\)/);
  });

  it("keeps context-policy state per chat (load + save keyed by activeId)", () => {
    expect(code).toMatch(/loadConversationState\(activeId\)/);
    expect(code).toMatch(/saveConversationState\(activeId, contextState\)/);
  });

  it("stream survives tab switches and is routed by chat id", () => {
    expect(code).toMatch(/streamSession\.chatId = activeId/);
    expect(code).toMatch(/streamSession\.active && streamSession\.chatId === id/);
    expect(code).toMatch(/streamIsBackground/);
  });

  it("background-chat actions are stored, not auto-run", () => {
    expect(code).toMatch(/conv\.pendingActions = \{ reasoning: /);
    expect(code).toContain("restorePendingActionsFor");
    expect(code).toContain("clearStoredPendingActions");
  });

  it("history view: search input wired + inline rename", () => {
    expect(code).toMatch(/historySearch\.value/);
    expect(code).toContain("startCardRename");
    expect(code).toContain("history-rename-input");
    expect(code).toMatch(/renameConversation\(conversations, item\.id/);
  });

  it("delete prunes the open-tab set and re-renders", () => {
    expect(code).toMatch(/pruneChatTabs\(tabsState, Object\.keys\(conversations\)\)/);
  });
});
describe("sidepanel Mode system", () => {
  it("has a Mode select element in HTML", () => {
    const htmlPath = resolve(import.meta.dir, "../extension/sidepanel.html");
    const html = readFileSync(htmlPath, "utf-8");
    expect(html).toContain('id="mode-select"');
    expect(html).toContain('id="create-mode-btn"');
  });

  it("imports the Mode catalog from lib/modes.js", () => {
    expect(code).toContain("./lib/modes.js");
    expect(code).toContain("BUILTIN_MODES");
    expect(code).toContain("resolveMode");
    expect(code).toContain("DEFAULT_MODE_ID");
  });

  it("has Mode lifecycle functions", () => {
    expect(code).toContain("function loadModes");
    expect(code).toContain("function applyMode");
    expect(code).toContain("function rebuildModeOptions");
    expect(code).toContain("function startModeCreation");
  });

  it("loads the active Mode from storage on init", () => {
    expect(code).toContain("loadConfig");
    expect(code).toContain("zoActiveMode");
    expect(code).toContain("chrome.storage.sync.get");
  });

  it("ships the built-in Modes in the dropdown", () => {
    const htmlPath = resolve(import.meta.dir, "../extension/sidepanel.html");
    const html = readFileSync(htmlPath, "utf-8");
    for (const m of ["cobrowse", "ask", "research", "summarize", "extract", "visual"]) {
      expect(html).toContain(`value="${m}"`);
    }
  });



  it("has save page command (#09)", () => {
    expect(code).toContain("SAVE_PAGE");
    expect(code).toContain("isSave");
    expect(code).toContain("savePath");
  });




  it("has action timeline rendering (#03)", () => {
    expect(code).toContain("renderActionTimeline");
    expect(code).toContain("updateActionCard");
    expect(code).toContain("ACTION_META");
    expect(code).toContain("action-card");
  });

  it("renders the timeline as an inline run block + groups repeats + tracks duration (Gaps 1/2/4)", () => {
    // Inline "⚡ Performed N actions · duration" tool-trace card in the chat stream.
    expect(code).toContain("function groupActions");
    expect(code).toContain("msg-action-run");
    expect(code).toContain("action-run-header");
    expect(code).toContain("⚡ Performed actions");
    expect(code).toContain("function formatDuration");
    // Duration is captured at run start/end.
    expect(code).toMatch(/runStartTime = Date\.now\(\)/);
    expect(code).toMatch(/Date\.now\(\) - runStartTime/);
    // The old duplicate inline ".msg-action" message per step is gone.
    expect(code).not.toContain("addMessage('action',");
  });

  it("has duckdb query commands (#05)", () => {
    expect(code).toContain("isDuckdb");
    expect(code).toContain("DUCKDB_QUERY");
    expect(code).toContain("addDuckdbResult");
    expect(code).toContain("renderTable");
  });

  it("has automation command (#08)", () => {
    expect(code).toContain("isAuto");
    expect(code).toContain("CREATE_AUTOMATION");
  });

  it("imports and dispatches bang commands (#07)", () => {
    // Logic now lives in extension/lib/bang-commands.js (unit-tested separately);
    // sidepanel.js imports it and dispatches via parseBangCommand in both sendQuery paths.
    expect(code).toContain("./lib/bang-commands.js");
    expect(code).toContain("parseBangCommand");
    expect(code).toContain("effectiveQuery");
    expect(code).toContain("tempMode");
  });
  it("adds system message on mode change", () => {
    expect(code).toContain("addSystemMessage");
    expect(code).toContain("mode active");
  });
});

describe("sidepanel thinking/reasoning bubble", () => {
  const cssPath = resolve(import.meta.dir, "../extension/styles.css");
  const css = readFileSync(cssPath, "utf-8");

  it("defines the addReasoningBubble helper", () => {
    expect(code).toContain("function addReasoningBubble");
  });

  it("renders short reasoning inline as muted prose (Zo model)", () => {
    // Short reasoning (<= INLINE_REASONING_MAX, single line) renders inline,
    // no collapse — mirrors Zo's interleaved thinking prose.
    expect(code).toContain("INLINE_REASONING_MAX");
    expect(code).toContain("msg-reasoning-inline");
    expect(css).toContain(".msg-reasoning-inline");
  });

  it("renders longer reasoning as a collapsible trace header (Zo model)", () => {
    expect(code).toContain("reasoning-toggle");
    expect(code).toContain("reasoning-content");
    expect(code).toContain('aria-expanded');
    expect(code).toContain("content.hidden = true");
  });

  it("shows a one-line summary in the collapsed header (matches zo.computer)", () => {
    expect(code).toContain("function reasoningSummary");
    expect(code).toContain("'💭 Thought'");
    expect(code).toContain("reasoning-summary");
    expect(css).toContain(".reasoning-summary");
  });

  it("no-ops on empty reasoning so non-reasoning modes are unaffected", () => {
    expect(code).toMatch(/if \(!text \|\| !text\.trim\(\)\) return/);
  });

  it("renders reasoning through the markdown escaper (text safety)", () => {
    expect(code).toContain("markdownToHtml(text)");
    expect(code).toContain("safeText(reasoning)");
  });

  it("attaches the bubble in the streaming STREAM_DONE path", () => {
    // Chronological feed: STREAM_DONE doesn't call addReasoningBubble unless no
    // chunks were streamed (fallback path). The reasoning is streamed inline as
    // .msg-stream-thought tokens. This test now checks the chronological feed path.
    expect(code).toContain("msg-stream-thought");
    expect(code).toMatch(/case ['"]STREAM_DONE['"]/);
  });

  it("persists reasoning with the assistant message (streaming write path)", () => {
    expect(code).toContain("reasoning: reasoningVal");
    // Now includes streamed reasoning (streamSession.reasoningText) as fallback.
    expect(code).toContain("msg.reasoning");
  });

  it("re-renders reasoning bubbles from history for assistant messages", () => {
    expect(code).toContain("if (m.role === 'assistant' && m.reasoning) addReasoningBubble(el, m.reasoning)");
  });

  it("styles the reasoning block, toggle, and content", () => {
    expect(css).toContain(".msg-reasoning");
    expect(css).toContain(".reasoning-toggle");
    expect(css).toContain(".reasoning-content");
    expect(css).toContain(".reasoning-caret");
    expect(css).toContain('.reasoning-toggle[aria-expanded="true"] .reasoning-caret');
    expect(css).toContain(".reasoning-content[hidden]");
  });

  it("places the reasoning block above the body (full-width, above .msg-body)", () => {
    // Regression guard: reasoning is inserted INSIDE .msg, full-width, above
    // the answer body so it reads reasoning → answer.
    expect(css).toMatch(/\.msg-reasoning\s*\{[^}]*width:\s*100%/);
  });
});

describe("sidepanel chronological streaming feed (Thought → Explored → Final)", () => {
  it("handles STREAM_REASONING messages for live reasoning deltas", () => {
    expect(code).toContain("case 'STREAM_REASONING'");
    expect(code).toContain("msg-stream-thought");
  });

  it("handles STREAM_TOOL messages for live tool-call/result events", () => {
    expect(code).toContain("case 'STREAM_TOOL'");
    expect(code).toContain("msg-stream-tool-card");
  });

  it("renders tool cards with pending/done/error states in chronological order", () => {
    expect(code).toContain("msg-stream-tool-icon");
    expect(code).toContain("msg-stream-tool-name");
    expect(code).toContain("msg-stream-tool-args");
    expect(code).toContain("msg-stream-tool-result");
    expect(code).toContain("msg-stream-tool-result-body");
  });

  it("STREAM_DONE adds TTS button and preserves chronological feed (no innerHTML overwrite)", () => {
    // Chronological feed: STREAM_DONE must NOT overwrite the message body's innerHTML
    // (which would break the chronological feed). It only adds TTS and falls back
    // to addMessage if no chunks arrived.
    expect(code).toMatch(/case ['"]STREAM_DONE['"]/);
    expect(code).toContain("tts-btn");
    // Should NOT contain the old grouped regions logic that set body.innerHTML
    // in the STREAM_DONE case. Check that there's no body.innerHTML = assignment
    // between STREAM_DONE case and the next case.
    const streamDoneMatch = code.match(/case 'STREAM_DONE':([\s\S]*?)case\s+/);
    const streamDoneBlock = streamDoneMatch ? streamDoneMatch[1] : '';
    expect(streamDoneBlock).not.toMatch(/body\.innerHTML\s*=/);
  });

  it("persists reasoning from streamSession and msg.reasoning to conversation", () => {
    // Chronological feed stores only reasoning (tools are in the body as cards).
    expect(code).toContain("streamSession.reasoningText");
    expect(code).toContain("msg.reasoning");
    expect(code).toContain("reasoning: reasoningVal");
  });
});

describe("sidepanel non-streaming ASK_ZO path normalizes key-first actions", () => {
  // Regression guard for the raw-JSON-in-chat bug: the non-streaming ASK_ZO
  // response handler must run actions through normalizeActions() (key-first →
  // type-first) so the done.response is found and reasoning bubbles render,
  // instead of the whole {reasoning, actions} blob leaking into the chat.
  it("imports normalizeActions from lib/modes.js", () => {
    expect(code).toMatch(/import\s*\{[^}]*\bnormalizeActions\b[^}]*\}\s*from\s*['"]\.\/lib\/modes\.js['"]/);
  });

  it("applies normalizeActions in both parse branches (object + JSON-string output)", () => {
    // Two call sites: the object branch and the string/JSON.parse branch.
    const matches = code.match(/normalizeActions\(/g) || [];
    // At least two usages in the response handler (plus the import, which is
    // not a call). We assert >=2 call sites to cover both branches.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Real DOM test: extract addReasoningBubble + deps from source via vm and
// drive it against a minimal hand-rolled DOM stub. Source-containment tests
// above only grep strings; this one proves the bubble actually renders.
describe("addReasoningBubble DOM behavior", () => {
  // Minimal DOM node stub covering the operations addReasoningBubble uses.
  class El {
    tag: string;
    children: El[] = [];
    parent: El | null = null;
    attrs: Record<string, string> = {};
    classes: string[] = [];
    _hidden = false;
    text = "";
    innerHTML = "";
    listeners: Record<string, Function> = {};
    constructor(tag: string) { this.tag = tag; }
    set className(v: string) { this.classes = v ? v.split(/\s+/) : []; }
    get className() { return this.classes.join(" "); }
    set textContent(v: string) { this.text = String(v ?? ""); this.innerHTML = ""; }
    get textContent() { return this.text; }
    set hidden(v: boolean) { this._hidden = !!v; }
    get hidden() { return this._hidden; }
    setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
    getAttribute(k: string) { return this.attrs[k] ?? null; }
    appendChild(c: El) { c.parent = this; this.children.push(c); return c; }
    insertBefore(c: El, ref: El | null) {
      c.parent = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx === -1) this.children.push(c);
      else this.children.splice(idx, 0, c);
      return c;
    }
    addEventListener(ev: string, fn: Function) { this.listeners[ev] = fn; }
    querySelector(sel: string): El | null {
      const cls = sel.startsWith(".") ? sel.slice(1).split(".")[0] : null;
      const tag = sel.startsWith(".") ? null : sel;
      return this._find(cls, tag);
    }
    _find(cls: string | null, tag: string | null): El | null {
      for (const c of this.children) {
        if ((!cls || c.classes.includes(cls)) && (!tag || c.tag === tag)) return c;
        const found = c._find(cls, tag);
        if (found) return found;
      }
      return null;
    }
    querySelectorAll(sel: string): El[] {
      const cls = sel.startsWith(".") ? sel.slice(1) : null;
      const out: El[] = [];
      const walk = (n: El) => {
        for (const c of n.children) {
          if (!cls || c.classes.includes(cls)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    get firstChild() { return this.children[0] ?? null; }
    click() { if (this.listeners.click) (this.listeners.click as () => void)(); }
  }

  // Brace-match a function body in the source by name.
  function extractFn(name: string): string {
    const start = code.indexOf("function " + name + "(");
    if (start === -1) throw new Error("fn not found: " + name);
    let depth = 0, started = false, end = start;
    for (let i = start; i < code.length; i++) {
      if (code[i] === "{") { depth++; started = true; }
      else if (code[i] === "}") { depth--; if (started && depth === 0) { end = i + 1; break; } }
    }
    return code.slice(start, end);
  }

  function loadAddReasoningBubble(): (parent: El, reasoning: any) => void {
    const sandbox: any = {};
    vm.createContext(sandbox);
    // Provide document.createElement to the stub.
    sandbox.document = { createElement: (t: string) => new El(t) };
    vm.runInContext(
      "const INLINE_REASONING_MAX = 120;\n" +
      extractFn("safeText") + "\n" +
      extractFn("reasoningSummary") + "\n" +
      extractFn("escapeHtml") + "\n" +
      extractFn("markdownToHtml") + "\n" +
      extractFn("addReasoningBubble"),
      sandbox,
    );
    if (typeof sandbox.addReasoningBubble !== "function") {
      throw new Error("failed to load addReasoningBubble");
    }
    return sandbox.addReasoningBubble;
  }

  it("renders SHORT reasoning inline ABOVE .msg-body (no collapse)", () => {
    const addReasoningBubble = loadAddReasoningBubble();
    const msg = new El("div");
    msg.className = "msg msg-assistant";
    const body = new El("div");
    body.className = "msg-body";
    msg.appendChild(body);

    const reasoning = "The page is a basic documentation landing page.";
    addReasoningBubble(msg, reasoning);

    // Inline block inserted before the body, carries the escaped reasoning.
    const block = msg.querySelector(".msg-reasoning-inline");
    expect(block).not.toBeNull();
    expect(block!.parent).toBe(msg);
    expect(msg.children[0]).toBe(block);
    expect(msg.children[1]).toBe(body);
    expect(block!.innerHTML).toContain("documentation landing page");
    // No toggle on the inline variant.
    expect(block!.querySelector(".reasoning-toggle")).toBeNull();
  });

  it("renders LONG reasoning as a collapsible trace ABOVE .msg-body", () => {
    const addReasoningBubble = loadAddReasoningBubble();
    const msg = new El("div");
    msg.className = "msg msg-assistant";
    msg.appendChild(Object.assign(new El("div"), { className: "msg-body" }));

    // > 120 chars and/or multi-line → collapsible trace header.
    const reasoning =
      "First I will inspect the page structure to understand the layout, " +
      "then I will identify the primary navigation and any forms present, " +
      "and finally I will decide which action best answers the user query.";
    addReasoningBubble(msg, reasoning);

    const block = msg.querySelector(".msg-reasoning");
    expect(block).not.toBeNull();
    expect(msg.children[0]).toBe(block);

    // Toggle header: "💭 Thought" label + summary preview, collapsed by default.
    const toggle = block!.querySelector(".reasoning-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(toggle!.querySelector(".reasoning-label")!.textContent).toContain("Thought");
    const summary = toggle!.querySelector(".reasoning-summary");
    expect(summary).not.toBeNull();

    // Content hidden by default, carries the escaped reasoning.
    const content = block!.querySelector(".reasoning-content");
    expect(content).not.toBeNull();
    expect(content!.hidden).toBe(true);
    expect(content!.innerHTML).toContain("inspect the page structure");

    // Click → expands: aria-expanded flips, content unhidden; click again collapses.
    toggle!.click();
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
    expect(content!.hidden).toBe(false);
    toggle!.click();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(content!.hidden).toBe(true);
  });

  it("no-ops on empty/whitespace reasoning (no block added)", () => {
    const addReasoningBubble = loadAddReasoningBubble();
    const msg = new El("div");
    msg.className = "msg msg-assistant";
    msg.appendChild(Object.assign(new El("div"), { className: "msg-body" }));
    const before = msg.children.length;

    addReasoningBubble(msg, "");
    addReasoningBubble(msg, "   ");
    addReasoningBubble(msg, null);
    addReasoningBubble(msg, undefined);

    expect(msg.children.length).toBe(before); // unchanged
    expect(msg.querySelector(".msg-reasoning")).toBeNull();
  });

  it("no-ops when parentMsgEl is null/falsy", () => {
    const addReasoningBubble = loadAddReasoningBubble();
    expect(() => addReasoningBubble(null, "reasoning")).not.toThrow();
    expect(() => addReasoningBubble(undefined, "reasoning")).not.toThrow();
  });

  it("does not duplicate the reasoning block on a second call", () => {
    const addReasoningBubble = loadAddReasoningBubble();
    const msg = new El("div");
    msg.className = "msg msg-assistant";
    msg.appendChild(Object.assign(new El("div"), { className: "msg-body" }));

    addReasoningBubble(msg, "reason one");
    addReasoningBubble(msg, "reason two");

    const blocks = msg.querySelectorAll(".msg-reasoning");
    expect(blocks.length).toBe(1);
    // First reasoning wins (guard short-circuits the second call).
    expect(blocks[0].innerHTML).toContain("reason one");
  });
});

// ── healAssistantMessage: fixes persisted history saved before the
// action-normalization fix (where the raw {reasoning, actions} JSON blob was
// stored as msg.text and re-rendered as raw JSON on every conversation load).
describe("healAssistantMessage — persisted-history repair", () => {
  function braceEnd(src: string, start: number): number {
    let depth = 0, started = false;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") { depth++; started = true; }
      else if (src[i] === "}") { depth--; if (started && depth === 0) return i + 1; }
    }
    return start;
  }
  function loadHealer() {
    const safeStart = code.indexOf("function safeText(");
    const safeEnd = braceEnd(code, safeStart);
    const healStart = code.indexOf("function healAssistantMessage(");
    const healEnd = braceEnd(code, healStart);
    const sandbox: any = { normalizeActions };
    vm.createContext(sandbox);
    vm.runInContext(code.slice(safeStart, safeEnd) + "\n" + code.slice(healStart, healEnd), sandbox);
    if (typeof sandbox.healAssistantMessage !== "function") {
      throw new Error("failed to load healAssistantMessage");
    }
    return sandbox.healAssistantMessage as (msg: any) => any;
  }

  it("heals a persisted key-first {reasoning, actions} blob into text + reasoning", () => {
    const heal = loadHealer();
    // Exactly the shape that leaked into history before the fix.
    const leaked = {
      role: 'assistant',
      text: JSON.stringify({
        reasoning: "The page failed to load. No content to extract.",
        actions: [{ done: { response: "The page refused the connection." } }],
      }),
      timestamp: 1,
    };
    const healed = heal(leaked);
    expect(healed.text).toBe("The page refused the connection.");
    expect(healed.reasoning).toBe("The page failed to load. No content to extract.");
    expect(healed.healed).toBe(true);
    // The raw JSON must be gone from the rendered text.
    expect(healed.text).not.toContain('"reasoning"');
    expect(healed.text).not.toContain('"actions"');
  });

  it("passes a normal assistant message's text/reasoning through unchanged", () => {
    const heal = loadHealer();
    const normal = { role: 'assistant', text: '## Summary\n\nNo links here.', reasoning: 'thoughts', timestamp: 2 };
    const out = heal(normal);
    // Non-JSON text is returned as-is (text + reasoning preserved, not repaired).
    expect(out.text).toBe(normal.text);
    expect(out.reasoning).toBe(normal.reasoning);
  });

  it("preserves existing reasoning when healing (doesn't clobber)", () => {
    const heal = loadHealer();
    const msg = {
      role: 'assistant',
      text: JSON.stringify({ reasoning: 'parsed-out reasoning', actions: [{ done: { response: 'ans' } }] }),
      reasoning: 'already-stored reasoning',
      timestamp: 3,
    };
    const out = heal(msg);
    expect(out.reasoning).toBe('already-stored reasoning');
  });

  it("does not treat non-JSON text or unrelated JSON as a leaked payload", () => {
    const heal = loadHealer();
    const plain = { role: 'assistant', text: 'Just a normal answer.', timestamp: 4 };
    expect(heal(plain).text).toBe('Just a normal answer.');
    // JSON object without reasoning/actions signature → not a leaked payload.
    const otherJson = { role: 'assistant', text: JSON.stringify({ foo: 1, bar: 2 }), timestamp: 5 };
    expect(heal(otherJson).text).toBe(JSON.stringify({ foo: 1, bar: 2 }));
  });

  it("returns non-assistant messages untouched", () => {
    const heal = loadHealer();
    const user = { role: 'user', text: JSON.stringify({ reasoning: 'x', actions: [] }), timestamp: 6 };
    expect(heal(user)).toBe(user);
    expect(heal(null)).toBe(null);
  });

  it("the render-from-history loops route assistant messages through healAssistantMessage", () => {
    // Source guard: both history render loops must call healAssistantMessage,
    // otherwise old conversations still render raw JSON.
    const callSites = (code.match(/healAssistantMessage\(msg\)/g) || []).length;
    expect(callSites).toBeGreaterThanOrEqual(2);
  });
});

// ── renderActionTimeline DOM behavior: inline "⚡ Performed N actions" tool-trace card
// (Gaps 1/2/4 — matches zo.computer). Exercises the real function extracted
// from sidepanel.js against a richer DOM stub that supports getElementById +
// dataset, which renderActionTimeline uses.
describe("renderActionTimeline DOM behavior — inline run block", () => {
  function extractFn(name: string): string {
    const start = code.indexOf("function " + name + "(");
    if (start === -1) throw new Error("fn not found: " + name);
    let depth = 0, started = false, end = start;
    for (let i = start; i < code.length; i++) {
      if (code[i] === "{") { depth++; started = true; }
      else if (code[i] === "}") { depth--; if (started && depth === 0) { end = i + 1; break; } }
    }
    return code.slice(start, end);
  }

  // DOM stub with dataset + getElementById + classList-ish class arrays.
  class RunEl {
    tag: string;
    id = "";
    children: RunEl[] = [];
    parent: RunEl | null = null;
    attrs: Record<string, string> = {};
    classes: string[] = [];
    _hidden = false;
    text = "";
    innerHTML = "";
    dataset: Record<string, string> = {};
    listeners: Record<string, Function> = {};
    constructor(tag: string) { this.tag = tag; }
    set className(v: string) { this.classes = v ? v.split(/\s+/).filter(Boolean) : []; }
    get className() { return this.classes.join(" "); }
    set textContent(v: string) { this.text = String(v ?? ""); this.innerHTML = ""; }
    get textContent() { return this.text; }
    set hidden(v: boolean) { this._hidden = !!v; }
    get hidden() { return this._hidden; }
    setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
    getAttribute(k: string) { return this.attrs[k] ?? null; }
    appendChild(c: RunEl) { c.parent = this; this.children.push(c); return c; }
    insertBefore(c: RunEl, ref: RunEl | null) {
      c.parent = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx === -1) this.children.push(c); else this.children.splice(idx, 0, c);
      return c;
    }
    addEventListener(ev: string, fn: Function) { this.listeners[ev] = fn; }
    // Minimal classList shim (renderActionTimeline calls actionsBar.classList.remove).
    get classList() {
      const self = this;
      return {
        add(c: string) { if (!self.classes.includes(c)) self.classes.push(c); },
        remove(c: string) { self.classes = self.classes.filter((x) => x !== c); },
        contains(c: string) { return self.classes.includes(c); },
        toggle(c: string, force?: boolean) {
          const has = self.classes.includes(c);
          const next = force === undefined ? !has : force;
          if (next && !has) self.classes.push(c);
          if (!next && has) self.classes = self.classes.filter((x) => x !== c);
          return next;
        },
      };
    }
    querySelector(sel: string): RunEl | null {
      const cls = sel.startsWith(".") ? sel.slice(1).split(".")[0] : null;
      return this._find(cls);
    }
    _find(cls: string | null): RunEl | null {
      for (const c of this.children) {
        if (!cls || c.classes.includes(cls)) return c;
        const found = c._find(cls);
        if (found) return found;
      }
      return null;
    }
    querySelectorAll(sel: string): RunEl[] {
      const cls = sel.startsWith(".") ? sel.slice(1) : null;
      const out: RunEl[] = [];
      const walk = (n: RunEl) => {
        for (const c of n.children) {
          if (!cls || c.classes.includes(cls)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    click() { if (this.listeners.click) (this.listeners.click as () => void)(); }
  }

  // Extract the `const ACTION_META = {...}` block (ends at its closing `};`).
  function extractConst(name: string): string {
    const start = code.indexOf("const " + name + " =");
    if (start === -1) throw new Error("const not found: " + name);
    let depth = 0, started = false, end = start;
    for (let i = code.indexOf("{", start); i < code.length; i++) {
      if (code[i] === "{") { depth++; started = true; }
      else if (code[i] === "}") { depth--; if (started && depth === 0) { end = i + 2; break; } } // include trailing `;\n`
    }
    return code.slice(start, end);
  }

  // Build a sandbox with the DOM stubs + ACTION_META + the timeline helpers,
  // run renderActionTimeline, and return the msgsEl/actionsBar for assertions.
  function renderTimeline(pending: any[]) {
    const msgsEl = new RunEl("div");
    const actionsBar = new RunEl("div");
    const sandbox: any = {
      document: { createElement: (t: string) => new RunEl(t), getElementById: () => null },
      pendingActions: pending,
      actionsBar,
      msgsEl,
    };
    vm.createContext(sandbox);
    vm.runInContext(
      extractFn("safeText") + "\n" + extractFn("escapeHtml") + "\n" +
      extractConst("ACTION_META") + "\n" +
      extractFn("actionDetail") + "\n" + extractFn("actionKey") + "\n" +
      extractFn("groupActions") + "\n" + extractFn("formatDuration") + "\n" +
      extractFn("renderActionTimeline"),
      sandbox,
    );
    sandbox.renderActionTimeline();
    return { msgsEl, actionsBar };
  }

  function findRun(msgsEl: RunEl): RunEl {
    const run = [...msgsEl.children].find((c) => c.classes.includes("msg-action-run"));
    if (!run) throw new Error("no .msg-action-run rendered");
    return run;
  }

  it("renders an inline .msg-action-run in the chat stream (not the bar)", () => {
    const { msgsEl, actionsBar } = renderTimeline([
      { type: "click", selector: "#a" },
      { type: "done", response: "ok" },
    ]);
    expect(() => findRun(msgsEl)).not.toThrow();
    const barHasRun = [...actionsBar.children].some((c) => c.classes.includes("msg-action-run"));
    expect(barHasRun).toBe(false);
  });

  it("the run header is collapsed by default (aria-expanded=false, body hidden)", () => {
    const { msgsEl } = renderTimeline([{ type: "click", selector: "#x" }]);
    const run = findRun(msgsEl);
    const header = run.children.find((c) => c.classes.includes("action-run-header"))!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    const body = run.children.find((c) => c.classes.includes("action-run-body"))!;
    expect(body.hidden).toBe(true);
  });

  it("expanding the header reveals the body", () => {
    const { msgsEl } = renderTimeline([{ type: "click", selector: "#x" }]);
    const run = findRun(msgsEl);
    const header = run.children.find((c) => c.classes.includes("action-run-header"))! as RunEl;
    const body = run.children.find((c) => c.classes.includes("action-run-body"))!;
    header.click();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
  });

  it("groups consecutive identical actions into one card with a count badge", () => {
    const { msgsEl } = renderTimeline([
      { type: "click", selector: "#go" },
      { type: "click", selector: "#go" },
      { type: "click", selector: "#go" },
      { type: "done", response: "ok" },
    ]);
    const cards = findRun(msgsEl).querySelectorAll(".action-card");
    // 3 identical clicks collapse to 1 card + 1 done card = 2 cards total.
    expect(cards.length).toBe(2);
    // The stub's innerHTML setter keeps the markup as a string (no parsed
    // children), so assert on the innerHTML content rather than querySelector.
    expect(cards[0].innerHTML, "first group has a × 3 count badge").toContain("× 3");
    expect(cards[1].innerHTML, "single done has no count badge").not.toContain("action-count");
  });

  it("escapes model/page-derived action details before innerHTML (#155)", () => {
    // A hostile page can plant markup in a field name / attribute value that
    // Zo echoes back in the action JSON — the detail span must render it as
    // text, never as markup.
    const { msgsEl } = renderTimeline([
      { type: "fill", value: '<img src=x onerror="window.__pwned=1">' },
      { type: "click", selector: "<script>alert(1)</script>" },
      { type: "done", response: "ok" },
    ]);
    const cards = findRun(msgsEl).querySelectorAll(".action-card");
    expect(cards.length).toBe(3);
    // Card 0: hostile fill VALUE (no selector → the value is the detail).
    expect(cards[0].innerHTML).not.toContain("<img");
    expect(cards[0].innerHTML).toContain("&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;");
    // Card 1: hostile selector.
    expect(cards[1].innerHTML).not.toContain("<script>");
    expect(cards[1].innerHTML).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

// ---- link chips + "Open all (N)" (research answers → tabs, #27) -----------

describe("addLinkChipsCard / openAllLinks DOM behavior", () => {
  class El {
    tag: string;
    children: El[] = [];
    attrs: Record<string, string> = {};
    classes: string[] = [];
    text = "";
    listeners: Record<string, Function> = {};
    constructor(tag: string) { this.tag = tag; }
    set className(v: string) { this.classes = v ? v.split(/\s+/) : []; }
    get className() { return this.classes.join(" "); }
    set textContent(v: string) { this.text = String(v ?? ""); }
    get textContent() { return this.text; }
    set title(v: string) { this.attrs.title = String(v); }
    get title() { return this.attrs.title ?? ""; }
    set type(v: string) { this.attrs.type = String(v); }
    get type() { return this.attrs.type ?? ""; }
    appendChild(c: El) { this.children.push(c); return c; }
    addEventListener(ev: string, fn: Function) { this.listeners[ev] = fn; }
    click() { if (this.listeners.click) (this.listeners.click as () => void)(); }
    querySelector(sel: string): El | null {
      const cls = sel.startsWith(".") ? sel.slice(1) : null;
      const walk = (n: El): El | null => {
        for (const c of n.children) {
          if (!cls || c.classes.includes(cls)) return c;
          const found = walk(c);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    }
    queryAllByClass(cls: string): El[] {
      const out: El[] = [];
      const walk = (n: El) => {
        for (const c of n.children) {
          if (c.classes.includes(cls)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
  }

  function extractFn(name: string): string {
    // Match the optional `async` prefix too — dropping it would strip the
    // async-ness and every `await` inside would become a syntax error.
    const start = code.search(new RegExp("(async )?function " + name + "\\("));
    if (start === -1) throw new Error("fn not found: " + name);
    let depth = 0, started = false, end = start;
    for (let i = start; i < code.length; i++) {
      if (code[i] === "{") { depth++; started = true; }
      else if (code[i] === "}") { depth--; if (started && depth === 0) { end = i + 1; break; } }
    }
    return code.slice(start, end);
  }

  const createCalls: Array<{ url?: string; active?: boolean }> = [];
  function loadCard() {
    createCalls.length = 0; // fresh recorder per test
    const sandbox: any = {};
    vm.createContext(sandbox);
    sandbox.document = { createElement: (t: string) => new El(t) };
    sandbox.chrome = { tabs: { create: (props: any = {}) => { createCalls.push({ ...props }); return Promise.resolve({ id: 9001 + createCalls.length }); } } };
    vm.runInContext(
      // var (not const/let) so the bindings attach to the sandbox object and
      // the test can inspect tabRefsEnabled / chatTabRefs afterwards.
      "var MAX_LINK_CHIPS = 10;\n" +
      "var tabRefsEnabled = new Set();\n" +
      "var chatTabRefs = new Map();\n" +
      "var activeId = 'chat-1';\n" +
      "var refreshOpenTabs = () => {};\n" +
      "var renderTabStrip = () => {};\n" +
      "var renderPromptInspector = () => {};\n" +
      extractFn("safeText") + "\n" +
      extractFn("openAllLinks") + "\n" +
      extractFn("addLinkChipsCard"),
      sandbox,
    );
    return sandbox;
  }

  const links = (n: number) => Array.from({ length: n }, (_, i) => ({
    url: `https://site-${i + 1}.example.com/page`,
    host: `site-${i + 1}.example.com`,
  }));

  it("renders no card below the 2-link threshold", () => {
    const s = loadCard();
    const msg = new El("div");
    expect(s.addLinkChipsCard(msg, links(1))).toBeNull();
    expect(s.addLinkChipsCard(msg, [])).toBeNull();
    expect(s.addLinkChipsCard(null, links(3))).toBeNull();
    expect(msg.children).toHaveLength(0);
  });

  it("renders header, host-labelled chips (title=url), and Open all (N)", () => {
    const s = loadCard();
    const msg = new El("div");
    const card = s.addLinkChipsCard(msg, links(3));
    expect(card).not.toBeNull();
    expect(msg.children[0]).toBe(card);
    expect(card!.querySelector(".msg-links-head")!.textContent).toBe("🔗 3 links");
    const chips = card!.queryAllByClass("msg-link-chip");
    expect(chips).toHaveLength(3);
    expect(chips[0].textContent).toBe("site-1.example.com");
    expect(chips[0].title).toBe("https://site-1.example.com/page");
    expect(card!.querySelector(".msg-links-open-all")!.textContent).toBe("Open all (3)");
  });

  it("is idempotent (history re-render never stacks cards)", () => {
    const s = loadCard();
    const msg = new El("div");
    expect(s.addLinkChipsCard(msg, links(2))).not.toBeNull();
    expect(s.addLinkChipsCard(msg, links(2))).toBeNull();
    expect(msg.queryAllByClass("msg-links")).toHaveLength(1);
  });

  it("caps display at MAX_LINK_CHIPS with a +N more note", () => {
    const s = loadCard();
    const msg = new El("div");
    const card = s.addLinkChipsCard(msg, links(12))!;
    expect(card.queryAllByClass("msg-link-chip")).toHaveLength(10);
    expect(card.querySelector(".msg-links-more")!.textContent).toBe("+2 more");
    expect(card.querySelector(".msg-links-open-all")!.textContent).toBe("Open all (10)");
    expect(card.querySelector(".msg-links-head")!.textContent).toBe("🔗 12 links");
  });

  it("a chip click opens that URL in the foreground", () => {
    const s = loadCard();
    const msg = new El("div");
    const card = s.addLinkChipsCard(msg, links(2))!;
    (card.queryAllByClass("msg-link-chip")[1] as El).click();
    expect(createCalls).toEqual([{ url: "https://site-2.example.com/page", active: true }]);
  });

  it("Open all opens first-foreground/rest-background and adds every tab as a reference chip for the active chat", async () => {
    const s = loadCard();
    const msg = new El("div");
    const card = s.addLinkChipsCard(msg, links(3))!;
    (card.querySelector(".msg-links-open-all") as El).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(createCalls.map((c) => c.active)).toEqual([true, false, false]);
    // All three synthetic tab ids became references for chat-1.
    const refs = s.chatTabRefs.get("chat-1") as Set<number>;
    expect([...refs].sort()).toEqual([9002, 9003, 9004]);
    expect((s.tabRefsEnabled as Set<number>).size).toBe(3);
  });
});

describe("link chips — wiring", () => {
  it("attaches the card at every assistant-answer surface (stream, fallback, done, history)", () => {
    const surfaces = ["addLinkChipsCard(streamSession.msgEl", "addLinkChipsCard(fallbackEl", "addLinkChipsCard(doneEl", "addLinkChipsCard(el, extractUrls(m.text))"];
    for (const s of surfaces) expect(code).toContain(s);
    expect(code).toContain("import { extractUrls, MAX_LINK_CHIPS } from './lib/links.js'");
  });

  it("skips the card on action turns (prose answers only)", () => {
    expect(code).toMatch(/!hasActions && responseText/);
    expect(code).toMatch(/!hasActions && fallbackEl/);
  });
});
