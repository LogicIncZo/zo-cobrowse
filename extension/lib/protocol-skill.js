// Protocol-skill install (#235) — pure half, no chrome.* / DOM / fetch deps.
//
// The extension bundles a versioned "cobrowse protocol" Zo skill
// (skills/zo-cobrowse/SKILL.md) and installs it into the user's Zo workspace
// so the per-turn action tail can slim to a pointer + envelope demand
// (invariant: the prompt is NEVER lighter than the verified install — the
// slim tail only engages on a verified read-back at the current version).
//
// The impure half (fetch of the bundled artifact, MCP read/write, session
// state) lives in background.js#ensureProtocolSkill; unit tests and the
// prompt assembler consume only these constants + functions.

/** Workspace install directory (Zo skills are plain folders). */
export const PROTOCOL_SKILL_DIR = '/home/workspace/Skills/zo-cobrowse';

/** Workspace install path for the skill's SKILL.md. */
export const PROTOCOL_SKILL_PATH = `${PROTOCOL_SKILL_DIR}/SKILL.md`;

/** In-repo (bundled) artifact path, relative to the extension root. */
export const BUNDLED_SKILL_PATH = 'skills/zo-cobrowse/SKILL.md';

/**
 * Reference files bundled next to SKILL.md (#412 — multi-file skill). Each
 * rides the same install: bundled path → workspace path under the skill dir.
 * References are best-effort — a failed reference write is recorded in the
 * state's `files` and never blocks the SKILL.md canary.
 */
export const BUNDLED_REFERENCE_PATHS = [
  'skills/zo-cobrowse/references/protocol.md',
  'skills/zo-cobrowse/references/features.md',
];

export function workspaceReferencePath(bundledPath) {
  const name = String(bundledPath || '').split('/').pop();
  return name ? `${PROTOCOL_SKILL_DIR}/references/${name}` : null;
}

/**
 * chrome.storage.session key holding the install state
 * ({installed, checkedVersion, version?, via?, reason?}). The sidepanel
 * inspector reads the same key so the preview mirrors what the background
 * will send.
 */
export const SKILL_STATE_KEY = 'cobrowse_protocol_skill';

/**
 * Stable marker inside the slim tail. The e2e mock + tests route/assert on
 * this string; it also names the skill in the pointer Zo reads.
 */
export const SKILL_MARKER = 'cobrowse-protocol-skill';

/**
 * The slim tail's pointer sentence — tells Zo where the protocol lives.
 * Followed by ACTION_ENVELOPE_DEMAND + SHARED_SAFETY_RULES (the rules stay
 * inline on EVERY action turn; only the grammar/semantics/pacing move
 * server-side — the skill carries all three, verbatim-canon).
 */
export const SKILL_POINTER =
  `Use the installed ${SKILL_MARKER} (Skills/zo-cobrowse) for the action protocol — grammar, cue ladders, pacing (references/protocol.md) — and for the product canon: Modes, bang commands, Recipes, handoff (references/features.md). Read it before acting.`;

/** The envelope demand — the one protocol line that must ride every turn. */
export const ACTION_ENVELOPE_DEMAND = 'Respond with JSON {"actions":[...]}';

/**
 * The read-turn pointer (#414). The live probe (probe-read-turn-awareness)
 * proved Zo does NOT consult workspace skills unprompted on read turns — it
 * answers feature questions generically (and contradicted the product's
 * human-checkpoint design). This one line rides read turns ONLY on a verified
 * install; mentioning the skill is what makes Zo read it (probe Q1: GO).
 */
export const READ_SKILL_POINTER =
  `When the user asks what the product can do or wants a repeatable workflow, consult the installed ${SKILL_MARKER} (Skills/zo-cobrowse) — references/features.md catalogues every surface.`;

/**
 * Rewrite the bundled artifact's frontmatter version to the extension version
 * at install time (the bundled file carries a placeholder — the manifest is
 * the version source of truth, and the version-sync lint gates it).
 * Pure: returns the new text; never mutates input.
 */
export function injectVersion(bundledText, version) {
  const text = typeof bundledText === 'string' ? bundledText : '';
  if (!text || !version) return text;
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return text;
  let block = fm[1];
  const line = `metadata:\n  version: "${version}"`;
  if (/^metadata:\s*$/m.test(block)) {
    block = /^\s*version:\s*.*$/m.test(block)
      ? block.replace(/^\s*version:\s*.*$/m, `  version: "${version}"`)
      : block.replace(/^metadata:\s*$/m, line);
  } else {
    block = `${block}\n${line}`;
  }
  return text.replace(/^---\n[\s\S]*?\n---/, `---\n${block}\n---`);
}

/**
 * Read the installed copy's frontmatter version (the `metadata.version` key
 * injected by injectVersion). Returns null when absent/unparseable — an
 * installed copy without a parseable version is treated as missing.
 */
export function parseInstalledVersion(installedText) {
  const text = typeof installedText === 'string' ? installedText : '';
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^\s*version:\s*["']?([^"'\n]+)["']?\s*$/m);
  const v = m && m[1] ? m[1].trim() : null;
  return v || null;
}

/**
 * Install decision: the skill needs (re)installing when the installed copy is
 * missing, unparseable, or at any version other than the extension's current
 * one. Same version → no-op.
 */
export function needsInstall({ installedText, extVersion }) {
  if (installedText === null || installedText === undefined) return true;
  return parseInstalledVersion(installedText) !== extVersion;
}
