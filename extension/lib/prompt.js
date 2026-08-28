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

import { ACTION_SCHEMA_COMPACT, PLAIN_RESPONSE_HINT } from './modes.js';
import { shouldDowngradeToJsonDisabled, detectIntent } from './intent.js';
import { buildTabManifest, isBlankPage } from './tab-contexts.js';
import { buildSkillLines, buildFileLines } from './pickers.js';

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
    push('files', 'Resolve these files with your file tools when the request needs their content.');
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
  if (tier >= 3 && ctx.screenshotDataUrl) {
    push('sep', '');
    push('screenshot', '## Screenshot');
    push('screenshot', `![page](${ctx.screenshotDataUrl})`);
  }

  push('sep', '');
  push('userRequest', '## User Request');
  push('userRequest', safeText(userQuery));
  push('sep', '');

  if (jsonDisabled) {
    push('tail', 'Answer the request directly using the page content provided.');
    push('tail', PLAIN_RESPONSE_HINT);
  } else {
    push('tail', mode.instructions);
    push('tail', wantJson ? ACTION_SCHEMA_COMPACT : PLAIN_RESPONSE_HINT);
  }

  return { parts, tier, intent: detectIntent(userQuery), expectJson: wantJson, downgradeApplied: jsonDisabled };
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

  return { prompt, sections, tier, intent, expectJson, downgradeApplied, approxTokens: estimateTokens(prompt) };
}
