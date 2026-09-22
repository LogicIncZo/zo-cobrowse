// Prompt assembly — pure logic, no chrome.* or DOM dependencies.
// The single source of truth for the `input` string sent to /zo/ask.
//
// buildPrompt() returns the exact prompt string (byte-identical to the
// historical background.js implementation when called without opts).
// describePrompt() returns the same prompt plus a structured, sectioned
// breakdown used by the side-panel inspector and the Settings editor — so
// what the user previews is guaranteed to be what the background sends.
//
// Both share one internal _compose() pass over tagged parts, so the string
// view and the structured view can never drift.
//
// Imported by background.js + sidepanel.js + options.js (ESM) and directly
// by tests. Also re-used by tests/test-prompts/capture.ts (killing the old
// hand-mirrored copy).

import { ACTION_SCHEMA_COMPACT, BUILTIN_MODES, NOT_ATTACHED_CONTRACT, PLAIN_RESPONSE_HINT } from './modes.js';
import { SKILL_POINTER, ACTION_ENVELOPE_DEMAND } from './protocol-skill.js';
import { shouldDowngradeToJsonDisabled, detectIntent } from './intent.js';
import { buildTabManifest, isBlankPage } from './tab-contexts.js';
import { buildSkillLines, buildFileLines } from './pickers.js';

/**
 * The #26 safety rules, stated EXACTLY ONCE per action turn (0.2.7 Lane A,
 * per the #71 prompt-bloat audit: persona/schema/instructions used to restate
 * them every turn). Composed into the tail only when the action envelope is
 * expected; modes and the schema must not restate them.
 */
export const SHARED_SAFETY_RULES =
  'Never propose password/card/CVV values. After filling a form, never click ANY button — submit/OK/Next/Create/any action button. Fill, then done(); the user reviews and clicks.';

/**
 * Section ids used to tag each assembled part. Stable ids so the inspector
 * and the Settings editor can refer to sections without matching labels.
 */
export const SECTION_IDS = Object.freeze([
  'system',
  'page',
  'tabs',
  'skills',
  'files',
  'content',
  'elements',
  'forms',
  'screenshot',
  'userRequest',
  'jev',
  'tail',
]);

/** Human labels for each section (the inspector/editor render these). */
export const SECTION_LABELS = Object.freeze({
  system: 'System Prompt',
  page: 'Page',
  tabs: 'Referenced Tabs',
  skills: 'Skills to Run',
  files: 'Referenced Files',
  content: 'Page Content',
  elements: 'Elements',
  forms: 'Forms',
  screenshot: 'Screenshot',
  userRequest: 'User Request',
  jev: 'Jev-Assisted Steps',
  tail: 'Instructions',
});

/**
 * Coerce any value to a safe string for interpolation into the prompt.
 * Strings pass through; null/undefined become ''; objects are JSON-stringified
 * (never rendered raw). Mirrors the historical background.js safeText.
 */
export function safeText(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  try {
    const s = JSON.stringify(v);
    return typeof s === 'string' ? s : '';
  } catch {
    return '';
  }
}

/** Compact one-line serializer for a clickable element. */
export function compactEl(e) {
  const text = (e.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const t = text ? ` "${text}"` : '';
  const sel = e.selector || '';
  return `[${e.tag || 'a'}${t}${sel ? ' ' + sel : ''}]`;
}

/** Compact one-line serializer for a form field. The `question` cue (nearest
 *  preceding title/label text) is the only disambiguator on builder-style
 *  forms where every field shares an identical placeholder and a UUID id. */
export function compactForm(f) {
  const ph = (f.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const sel = f.selector || '';
  const ty = f.type ? ` type=${f.type}` : '';
  const p = ph ? ` "${ph}"` : '';
  const q = (f.question || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const qs = q ? ` — ${q}` : '';
  return `[${f.tag || 'input'}${sel}${ty}${p}]${qs}`;
}

/**
 * The action-turn tail (#235). Full by default — instructions + grammar +
 * semantics inline (ACTION_SCHEMA_COMPACT) with the safety rules. When the
 * protocol skill is VERIFIED installed (opts.protocolSkill.installed —
 * background read-back), the tail slims to a skill pointer + envelope demand;
 * the safety rules NEVER move server-side (the tail is never lighter than the
 * verified install, and the #26 gate stays in-prompt on every turn).
 *
 * The builtin pacing instructions drop too — they are canon IN the skill —
 * but only when they are still byte-identical to the builtin: a user's tuned
 * instructions always ride, whatever the install state.
 */
function actionTail(opts, mode, wantJson) {
  // opts.noSlimTail (#343 follow-up): compose turns keep the FULL action
  // tail — the slim pointer sends Zo to read the skill from the workspace
  // mid-run, and one polluted/failed read there costs minutes (observed on
  // a real compose run). Regular action turns keep the slim pointer.
  const slim = wantJson && opts && opts.protocolSkill && opts.protocolSkill.installed && !opts.noSlimTail;
  if (!slim) {
    return { instructions: mode.instructions, protocol: `${ACTION_SCHEMA_COMPACT}${SHARED_SAFETY_RULES}` };
  }
  const instructionsKept = mode.instructions !== BUILTIN_MODES.cobrowse.instructions;
  return {
    instructions: instructionsKept ? mode.instructions : null,
    protocol: `${SKILL_POINTER} ${ACTION_ENVELOPE_DEMAND}. ${SHARED_SAFETY_RULES}`,
  };
}

/**
 * Resolve the effective context tier for a turn. An explicit effectiveTier
 * (passed by the context policy / inspector) overrides the Mode's configured
 * tier for section gating only; the screenshot ceiling still requires real
 * capture (a screenshotDataUrl must be present).
 */
function resolveTier(mode, opts) {
  const t = opts && Number.isInteger(opts.effectiveTier) ? opts.effectiveTier : mode.contextTier;
  // Clamp to the documented 0-3 range; anything else falls back to the Mode.
  if (t < 0 || t > 3) return mode.contextTier;
  return t;
}

/**
 * Build the ordered, tagged parts that make up the prompt. Each part carries
 * the section id it belongs to (or 'sep' for blank-line separators). The
 * prompt string is parts.map(p => p.text).join('\n'); the structured view
 * groups consecutive same-section parts.
 *
 * @returns {{ parts: Array<{section: string, text: string}>, tier: number, intent: 'action'|'read', expectJson: boolean, downgradeApplied: boolean }}
 */
function _compose(mode, pageContext, userQuery, opts) {
  const ctx = pageContext || {};
  const tier = resolveTier(mode, opts);
  const jsonDisabled = shouldDowngradeToJsonDisabled(mode, userQuery);
  const wantJson = mode.expectJson && !jsonDisabled;

  const parts = [];
  const push = (section, text) => parts.push({ section, text });

  push('system', mode.systemPrompt);
  push('sep', '');
  // Cold start: a blank/new-tab page (or no URL at all) carries no page
  // pointer — the whole ## Page section is omitted rather than sending
  // newtab/empty-field noise. Zo reading no Page section = no page attached.
  const noPagePointer = !safeText(ctx.url) || isBlankPage(ctx.url);
  if (!noPagePointer) {
    push('page', '## Page');
    push('page', `- URL: ${safeText(ctx.url)}`);
    push('page', `- Title: ${safeText(ctx.title)}`);
    push('page', `- Viewport: ${ctx.viewport?.w || '?'}x${ctx.viewport?.h || '?'}`);
  }

  // Referenced tabs (tab contexts). Manifest + excerpt only — full content is
  // pulled on demand via read_tab. When this turn attaches the active tab
  // (tier >= 1) its manifest line dedups ("attached above") since the content
  // already rides in ## Page Content.
  const tabs = Array.isArray(opts && opts.tabContexts) ? opts.tabContexts.filter((t) => t && typeof t === 'object') : [];
  if (tabs.length) {
    const { rendered } = buildTabManifest(tabs, { activeTabAttached: tier >= 1 });
    push('sep', '');
    push('tabs', '## Referenced Tabs');
    for (const line of rendered.split('\n')) push('tabs', line);
  }

  // Picked skills (`/` picker): a per-turn invocation. Each line names the
  // skill + its workspace folder so Zo reads its own SKILL.md server-side.
  const skills = Array.isArray(opts && opts.skills) ? opts.skills.filter((s) => s && typeof s === 'object' && s.name) : [];
  if (skills.length) {
    push('sep', '');
    push('skills', '## Skills to Run');
    for (const line of buildSkillLines(skills)) push('skills', line);
    push('skills', 'Run each skill above as part of this turn: read its SKILL.md and follow its instructions.');
  }

  // Picked workspace files (`%` picker): paths only — Zo resolves content
  // server-side with its own file tools (read_file/grep_search).
  const wfFiles = Array.isArray(opts && opts.workspaceFiles) ? opts.workspaceFiles.filter((f) => f && typeof f === 'object' && f.path) : [];
  if (wfFiles.length) {
    push('sep', '');
    push('files', '## Referenced Files');
    for (const line of buildFileLines(wfFiles)) push('files', line);
    push('files', 'Resolve these paths with your file tools when the request needs their content — files: read them; directories: list/recurse as needed.');
  }

  if (tier >= 1) {
    const text = safeText(ctx.visibleText || '—empty—').substring(0, mode.textBudget);
    push('sep', '');
    push('content', '## Page Content');
    push('content', '```');
    push('content', text);
    push('content', '```');
  }
  if (tier >= 2) {
    const els = ctx.clickable;
    if (Array.isArray(els) && els.length) {
      push('sep', '');
      push('elements', '## Elements');
      push('elements', els.slice(0, 50).map(compactEl).join(''));
    }
    const forms = ctx.formFields;
    if (Array.isArray(forms) && forms.length) {
      push('forms', '## Forms');
      push('forms', forms.slice(0, 30).map(compactForm).join(''));
    }
  }
  // Screenshot: rides at tier 3, OR on a DOM-capped turn when the user armed
  // the 📷 toggle with the #69 DOM toggle off (screenshot-only turn — pixels
  // are a separate channel from the capped-out DOM).
  if ((tier >= 3 || (opts && opts.screenshotOnly)) && ctx.screenshotDataUrl) {
    push('sep', '');
    push('screenshot', '## Screenshot');
    push('screenshot', `![page](${ctx.screenshotDataUrl})`);
  }

  push('sep', '');
  push('userRequest', '## User Request');
  push('userRequest', safeText(userQuery));

  // #343 (Lane J3): the Jev-assisted steps vocabulary — present ONLY when the
  // user opted in with a key (opts.jevAssist, threaded from the background's
  // config) and only on action turns (wantJson — the POST-downgrade decision,
  // #355: gating on mode.expectJson let the block ride read-downgraded turns,
  // where no action can execute). Keeps the pick-annotated click shape + its
  // guardrails in front of Zo; absent otherwise, so the prompt (and its token
  // cost) is byte-identical for everyone else.
  if (opts && opts.jevAssist && wantJson) {
    push('sep', '');
    push('jev', '## Jev-Assisted Steps (active)');
    // #357: tightened 148→123 tokens — it rides every action turn for
    // Jev-enabled users. Semantics preserved verbatim-in-meaning: only-when-
    // ambiguous, ask WHICH not HOW, Jev cannot fill/navigate/write values,
    // auto-execute vs park. The pick JSON shape + header are test-pinned.
    push('jev', 'Delegate an ambiguous click target to Jev — a fast decision model that sees this page\'s clickable elements: { "type": "click", "pick": { "question": "<one literal question naming which element to click>" } }. Use pick ONLY when you cannot confidently name a selector from the capture above. Ask WHICH element — never HOW: Jev cannot fill, navigate, or write values. A confident answer executes automatically; a low-confidence one parks the step for the user.');
  }

  push('sep', '');

  if (jsonDisabled) {
    // #237 (spike GO — tests/test-prompts/probe-thread-tail.json): on an
    // ESTABLISHED thread (the conversation_id echo already arrived) Zo retains
    // the context contract, so read/downgraded follow-ups ride a stub instead
    // of re-stating it. First turns and threadless callers (handoff/heal use
    // their own assemblers) keep the full honest tail.
    const stub = opts && opts.establishedThread;
    if (stub) {
      push('tail', 'Continue on this thread. Answer the request directly in plain markdown.');
    } else {
      push('tail', tier === 0
        ? `${NOT_ATTACHED_CONTRACT} Answer the request directly.`
        : 'Answer the request directly using the page content provided.');
      push('tail', PLAIN_RESPONSE_HINT);
    }
  } else {
    const tail = actionTail(opts, mode, wantJson);
    if (tail.instructions) push('tail', tail.instructions);
    push('tail', wantJson ? tail.protocol : PLAIN_RESPONSE_HINT);
  }
  // Tier-0 honesty: when no page content rides, say so — exactly ONCE (#70).
  // NOT_ATTACHED_CONTRACT is the one canonical sentence (#236): turns that
  // already carry it (the read-downgrade tier-0 tail, Lean's instructions)
  // suppress the generic copy via exact-inclusion match below. Skipped when
  // there is no page pointer at all — and on #237 established-thread stub
  // turns (the thread already holds the contract).
  if (tier === 0 && !noPagePointer) {
    const stub = opts && opts.establishedThread;
    const alreadyDisclaimed = stub || parts.some((p) => p.text.includes(NOT_ATTACHED_CONTRACT));
    if (!alreadyDisclaimed) {
      push('tail', NOT_ATTACHED_CONTRACT);
    }
  }

  return { parts, tier, intent: detectIntent(userQuery), expectJson: wantJson, downgradeApplied: jsonDisabled, protocolSkill: (opts && opts.protocolSkill) || null };
}

/**
 * Build the single `input` string sent to /zo/ask. The Mode decides system
 * prompt, instructions, how much page context (tier), the text budget, and
 * whether to append the action protocol. opts.effectiveTier overrides the
 * Mode's tier for section gating (used by the context policy to thin the
 * prompt on opt-in / send-once turns).
 *
 * @param {object} mode
 * @param {object} pageContext
 * @param {string} userQuery
 * @param {{ effectiveTier?: number }} [opts]
 * @returns {string}
 */
export function buildPrompt(mode, pageContext, userQuery, opts) {
  return _compose(mode, pageContext, userQuery, opts).parts.map((p) => p.text).join('\n');
}

/**
 * Rough token estimate (chars / 4). MV3 service workers have no tokenizer;
 * this is an approximation for the inspector — labelled "approx" in the UI.
 */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Group tagged parts into structured sections (consecutive same-section runs
 * joined), dropping blank separators. Preserves first-seen order. Used by
 * describePrompt for the inspector / Settings preview.
 */
function _groupSections(parts) {
  const sections = [];
  let current = null;
  for (const p of parts) {
    if (p.section === 'sep') continue;
    if (!current || current.id !== p.section) {
      current = {
        id: p.section,
        label: SECTION_LABELS[p.section] || p.section,
        included: true,
        editable: p.section === 'system' || p.section === 'tail',
        text: p.text,
      };
      sections.push(current);
    } else {
      current.text += `\n${p.text}`;
    }
  }
  return sections;
}

/**
 * The prompt plus a structured breakdown for the inspector / Settings editor.
 * `prompt` is exactly what buildPrompt returns; `sections` is the ordered,
 * human-labelled view; metadata surfaces the resolved tier, intent, and
 * effective JSON/markdown decision so the UI can explain what will be sent.
 *
 * @returns {{ prompt: string, sections: Array, tier: number, intent: 'action'|'read', expectJson: boolean, downgradeApplied: boolean, approxTokens: number }}
 */
export function describePrompt(mode, pageContext, userQuery, opts) {
  const { parts, tier, intent, expectJson, downgradeApplied } = _compose(mode, pageContext, userQuery, opts);
  const prompt = parts.map((p) => p.text).join('\n');
  const sections = _groupSections(parts);

  // Richer per-section meta where it's cheap to compute.
  const tabsCount = Array.isArray(opts && opts.tabContexts) ? opts.tabContexts.filter((t) => t && typeof t === 'object').length : 0;
  const skillsMeta = Array.isArray(opts && opts.skills) ? opts.skills.filter((s) => s && typeof s === 'object' && s.name).length : 0;
  const filesMeta = Array.isArray(opts && opts.workspaceFiles) ? opts.workspaceFiles.filter((f) => f && typeof f === 'object' && f.path).length : 0;
  for (const s of sections) {
    if (s.id === 'elements') s.meta = `${(pageContext?.clickable || []).length} elements`;
    else if (s.id === 'forms') s.meta = `${(pageContext?.formFields || []).length} fields`;
    else if (s.id === 'content') s.meta = `${s.text.length} chars`;
    else if (s.id === 'tabs') s.meta = `${tabsCount} tab${tabsCount === 1 ? '' : 's'}`;
    else if (s.id === 'skills') s.meta = `${skillsMeta} skill${skillsMeta === 1 ? '' : 's'}`;
    else if (s.id === 'files') s.meta = `${filesMeta} file${filesMeta === 1 ? '' : 's'}`;
  }

  // The tail section's label depends on the response-format decision.
  const tail = sections.find((s) => s.id === 'tail');
  if (tail) {
    tail.label = expectJson
      ? 'Response Format · JSON actions'
      : downgradeApplied
        ? 'Instructions · read override'
        : 'Instructions';
  }

  return { prompt, sections, tier, intent, expectJson, downgradeApplied, protocolSkill: (opts && opts.protocolSkill) || null, approxTokens: estimateTokens(prompt) };
}
