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
 *  textarea that the user can edit. Mirrored inline in content.js (which can't
 *  import this module); keep the two in sync.
 *  @param {{tag?:string,disabled?:boolean,readOnly?:boolean}|null} info
 *  @returns {boolean} */
export function isEnhanceableField(info) {
  const i = info || {};
  if (String(i.tag || '').toUpperCase() !== 'TEXTAREA') return false;
  if (i.disabled) return false;
  if (i.readOnly) return false;
  return true;
}

/**
 * Build the one-shot enhance prompt. Honest-copy by design: Zo may expand the
 * lead into a full answer but must not invent specifics the lead doesn't imply,
 * and must reply with ONLY plain text (it is written straight into a form
 * field). Field + page context are included as lightweight cues only.
 *
 * @param {object} args
 * @param {string} [args.text]        the current textarea value (the lead)
 * @param {string} [args.instruction] optional one-line user instruction
 * @param {{label?:string,placeholder?:string,maxLength?:number|null}} [args.field]
 * @param {{url?:string,title?:string}} [args.page]
 * @returns {string} the prompt to send as `input`
 */
export function buildEnhancePrompt({ text, instruction, field, page } = {}) {
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
  lines.push('- Reply with ONLY the improved text. No markdown, no headings, no bullet lists, no preamble, and no surrounding quotes.');
  if (maxLength) lines.push(`- Keep the result within ${maxLength} characters (the field's limit).`);
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
 * Normalize Zo's reply into bare text safe to write into a field: trim, drop a
 * wrapping code fence, and strip ONE wrapping pair of matching quotes (straight
 * or curly). Never strips inner quotes.
 * @param {string} raw
 * @returns {{text:string}}
 */
export function parseEnhanceResponse(raw) {
  let t = String(raw == null ? '' : raw).trim();
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
