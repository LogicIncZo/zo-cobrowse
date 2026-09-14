// Textarea write-assist — pure logic, no chrome.* or DOM dependencies.
// The content script owns the in-page widget (icon + popover + fill-back) but
// cannot import ES modules (MV3 content scripts are classic scripts), so it
// ships raw field data to the background via ENHANCE_TEXT. The background —
// a module — builds the prompt here, calls Zo, and parses the reply here.
// Keeping prompt assembly + response parsing in this lib makes them the single
// tested source of truth for the feature's AI contract.

/** Stable marker baked into every enhance prompt so the e2e mock Zo server can
 *  route on it (it keys scenarios off prompt content). */
export const WRITE_ASSIST_MARKER = 'write-assist';

/** Eligibility rule for the floating icon. A field is enhanceable when it is a
 *  textarea or a contenteditable rich editor (CodeMirror — GitHub's new issue
 *  form, ProseMirror, Lexical…) that the user can edit. Mirrored inline in
 *  content.js (which can't import this module); keep the two in sync.
 *  @param {{tag?:string,disabled?:boolean,readOnly?:boolean,editable?:boolean}|null} info
 *  @returns {boolean} */
export function isEnhanceableField(info) {
  const i = info || {};
  if (i.editable) return true; // contenteditable rich editor
  if (String(i.tag || '').toUpperCase() !== 'TEXTAREA') return false;
  if (i.disabled) return false;
  if (i.readOnly) return false;
  return true;
}

/**
 * Build the one-shot enhance prompt. Honest-copy by design: Zo may expand the
 * lead into a full answer but must not invent specifics the lead doesn't imply.
 * The reply uses a TAG PROTOCOL — final text between <write-assist> tags,
 * nothing outside — because Zo otherwise treats the call as a full agent turn
 * (live-observed: a "Let me quickly ground this…" warm-up + a `cat` command
 * before the answer, with the narration riding into the returned text). Tools
 * are explicitly off: this is a field-scoped one-shot, not a research turn.
 *
 * @param {object} args
 * @param {string} [args.text]        the current textarea value (the lead)
 * @param {string} [args.instruction] optional one-line user instruction
 * @param {{label?:string,placeholder?:string,maxLength?:number|null,markdown?:boolean}} [args.field]
 * @param {{url?:string,title?:string}} [args.page]
 * @param {boolean} [args.acceptsMarkdown] target renders Markdown (contenteditable editors)
 * @returns {string} the prompt to send as `input`
 */
export function buildEnhancePrompt({ text, instruction, field, page, acceptsMarkdown } = {}) {
  const lead = String(text == null ? '' : text).trim();
  const instr = String(instruction == null ? '' : instruction).trim();
  const f = field || {};
  const p = page || {};
  const label = String(f.label || '').trim();
  const placeholder = String(f.placeholder || '').trim();
  const maxLen = Number(f.maxLength);
  const maxLength = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : null;
  const url = String(p.url || '').trim();
  const title = String(p.title || '').trim();

  const lines = [];
  lines.push(`You are Zo, a writing assistant inside the user's browser (task: ${WRITE_ASSIST_MARKER}).`);
  lines.push("Rewrite and expand the user's draft so it reads as a complete, polished answer for the form field.");
  lines.push('');
  lines.push('Rules:');
  lines.push("- Keep the user's voice and first-person point of view.");
  lines.push('- Expand the lead into a full answer, but do NOT invent specific facts, numbers, names, or dates that the lead does not imply.');
  lines.push('- Work only from the draft and the context above — do not use tools, run commands, or search.');
  lines.push(`- Put the final text for the field between <${WRITE_ASSIST_MARKER}> and </${WRITE_ASSIST_MARKER}> tags, and NOTHING outside the tags: no narration, no warm-ups ("Let me..."), no commentary.`);
  if (acceptsMarkdown) {
    lines.push('- The field accepts Markdown: headings, lists, bold, and links are welcome where they help.');
  } else {
    lines.push('- The field is plain text: no markdown, no headings, no bullet lists.');
  }
  if (maxLength) lines.push(`- Keep the final text within ${maxLength} characters (the field's limit).`);
  lines.push('');
  if (label || placeholder) {
    lines.push('Field being filled:');
    if (label) lines.push(`- Label: ${label}`);
    if (placeholder) lines.push(`- Placeholder: ${placeholder}`);
    lines.push('');
  }
  if (url || title) {
    lines.push('Page (context only):');
    if (title) lines.push(`- Title: ${title}`);
    if (url) lines.push(`- URL: ${url}`);
    lines.push('');
  }
  if (instr) {
    lines.push(`The user's instruction for this rewrite: ${instr}`);
    lines.push('');
  }
  lines.push('Draft text to improve:');
  lines.push('"""');
  lines.push(lead);
  lines.push('"""');
  return lines.join('\n');
}

/**
 * Follow-up iteration prompt (#53): a Shorter/Formaler/custom chip re-works
 * the PREVIOUS result on the same short-lived per-popover Zo thread (the
 * caller threads conversation_id; the prior draft rides in the prompt so a
 * lost thread still degrades to a correct fresh rewrite). Same tag protocol
 * and no-tools rules as the initial prompt — narration outside the tags is
 * dropped by the parser, never rendered.
 */
export function buildEnhanceFollowUpPrompt({ priorText, instruction, field, page, acceptsMarkdown } = {}) {
  const prior = String(priorText == null ? '' : priorText).trim();
  const instr = String(instruction == null ? '' : instruction).trim();
  const f = field || {};
  const p = page || {};
  const maxLength = Number.isFinite(Number(f.maxLength)) && Number(f.maxLength) > 0 ? Number(f.maxLength) : null;

  const lines = [];
  lines.push(`You are Zo, a writing assistant inside the user's browser (task: ${WRITE_ASSIST_MARKER}).`);
  lines.push('This is a FOLLOW-UP iteration: revise the prior draft below per the user\'s instruction.');
  lines.push('');
  lines.push('Rules:');
  lines.push("- Keep the user's voice and first-person point of view.");
  lines.push('- Apply the instruction, but do NOT invent specific facts, numbers, names, or dates the prior draft does not contain.');
  lines.push('- Work only from the prior draft and the context above — do not use tools, run commands, or search.');
  lines.push(`- Put the FULL revised text for the field between <${WRITE_ASSIST_MARKER}> and </${WRITE_ASSIST_MARKER}> tags, and NOTHING outside the tags: no narration, no warm-ups, no commentary.`);
  if (acceptsMarkdown) {
    lines.push('- The field accepts Markdown: headings, lists, bold, and links are welcome where they help.');
  } else {
    lines.push('- The field is plain text: no markdown, no headings, no bullet lists.');
  }
  if (maxLength) lines.push(`- Keep the final text within ${maxLength} characters (the field's limit).`);
  lines.push('');
  const url = String(p.url || '').trim();
  const title = String(p.title || '').trim();
  if (url || title) {
    lines.push('Page (context only):');
    if (title) lines.push(`- Title: ${title}`);
    if (url) lines.push(`- URL: ${url}`);
    lines.push('');
  }
  lines.push(instr ? `The user's instruction for this revision: ${instr}` : 'The user\'s instruction for this revision: polish the draft.');
  lines.push('');
  lines.push('Prior draft (your previous output for this field):');
  lines.push('"""');
  lines.push(prior);
  lines.push('"""');
  return lines.join('\n');
}

/**
 * Normalize Zo's reply into bare field text. With the tag protocol, anything
 * OUTSIDE <write-assist>…</write-assist> is intermediate agent narration
 * (thought warm-ups, tool summaries) and is dropped; untagged replies fall
 * back to trim + strip a wrapping code fence and ONE wrapping quote pair
 * (never inner quotes).
 * @param {string} raw
 * @returns {{text:string}}
 */
/**
 * Streaming-safe partial parse (#53): what the popover may SHOW right now
 * from the accumulated raw stream text. Only content after the
 * <write-assist> open tag ever renders — narration before the tag (the
 * "Let me quickly ground this…" warm-ups the live model emits) is dropped
 * wholesale, and everything from the close tag on is trimmed. Never
 * throws; a stream with no open tag yet renders nothing.
 */
export function parseEnhanceDelta(raw) {
  const t = String(raw == null ? '' : raw);
  const openTag = `<${WRITE_ASSIST_MARKER}>`;
  const open = t.indexOf(openTag);
  if (open === -1) return '';
  let body = t.slice(open + openTag.length);
  const closeIdx = body.indexOf(`</${WRITE_ASSIST_MARKER}>`);
  if (closeIdx !== -1) body = body.slice(0, closeIdx);
  return body.replace(/^[ \t]*\r?\n/, '').trimStart();
}

export function parseEnhanceResponse(raw) {
  let t = String(raw == null ? '' : raw).trim();
  const openTag = `<${WRITE_ASSIST_MARKER}>`;
  const closeTag = `</${WRITE_ASSIST_MARKER}>`;
  const open = t.indexOf(openTag);
  if (open !== -1) {
    const close = t.lastIndexOf(closeTag);
    if (close > open) t = t.slice(open + openTag.length, close).trim();
  }
  const fence = t.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fence) t = String(fence[1] || '').trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === '\u201c' && last === '\u201d')) {
      t = t.slice(1, -1).trim();
    }
  }
  return { text: t };
}
