// Composer reference pickers (#28) — pure logic, no chrome.*/DOM deps, no
// fetch (transport lives in background.js).
//
// `/` enumerates the user's Zo skills by listing /home/workspace/Skills (the
// Zo-native skills folder — owner-verified 2026-08-18; /root/.agents/skills
// belongs to other agent CLIs and is deliberately NOT used). `%` browses the
// workspace at /home/workspace. Both run over the MCP server's `bash` tool
// because the alternative, `list_directory`, recurses and truncates at 1000
// entries — unusable for enumeration.
//
// The `bash` tool returns stdout wrapped in a Python-style repr
// (CmdResult(stdout='…', …)) with escaped newlines; every command below emits
// __ZO_BEGIN__/__ZO_END__ markers so extraction survives any wrapper noise.
// All paths are validated against the workspace root and single-quoted —
// picker input never reaches the shell unvalidated.

export const WORKSPACE_ROOT = '/home/workspace';
export const SKILLS_DIR = '/home/workspace/Skills';

const STDOUT_BEGIN = '__ZO_BEGIN__';
const STDOUT_END = '__ZO_END__';
/** SKILL.md head lines fetched per skill — enough to cover the frontmatter. */
const SKILL_HEAD_LINES = 14;
/** Render cap for a skill description (picker list + prompt line). */
export const SKILL_DESC_MAX = 200;

/**
 * Lexically normalize a path and confine it to the workspace root. Returns
 * the normalized absolute path, or null when the input is relative, escapes
 * the root (`..` traversal), contains control characters, or is too long.
 * The root itself is allowed.
 *
 * @param {string} input
 * @param {string} [root=WORKSPACE_ROOT]
 * @returns {string | null}
 */
export function safeWorkspacePath(input, root = WORKSPACE_ROOT) {
  if (typeof input !== 'string' || !input) return null;
  if (input.includes('\0')) return null;
  if (!input.startsWith('/')) return null;
  const rootNorm = root.replace(/\/+$/, '');
  const parts = [];
  for (const seg of input.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null; // tried to climb above the input root
      parts.pop();
      continue;
    }
    if (/[\n\r]/.test(seg)) return null;
    parts.push(seg);
  }
  const norm = '/' + parts.join('/');
  if (norm !== rootNorm && !norm.startsWith(rootNorm + '/')) return null;
  if (norm.length > 512) return null;
  return norm;
}

/**
 * Single-quote a string for safe shell interpolation ('…' with the usual
 * '\'' escaping). Used only after safeWorkspacePath validation.
 * @param {string} s
 */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** One bash command that dumps every skill folder's SKILL.md head. The
 *  ##SKILL_COUNT line rides FIRST (inside the markers) so a server-side
 *  output truncation can still be detected by comparing counts (#73). */
export function skillsListCommand(skillsDir = SKILLS_DIR) {
  return [
    `echo ${STDOUT_BEGIN};`,
    `echo "##SKILL_COUNT $(ls -1d ${shellQuote(skillsDir)}/*/ 2>/dev/null | wc -l)";`,
    `for d in ${shellQuote(skillsDir)}/*/; do`,
    `f="\${d}SKILL.md";`,
    `if [ -f "$f" ]; then echo "##SKILL \${d%/}"; sed -n '1,${SKILL_HEAD_LINES}p' "$f"; echo; fi;`,
    `done;`,
    `echo ${STDOUT_END};`,
  ].join(' ');
}

/** One bash command that lists a single directory, one entry per line (`ls -1F`). */
export function dirListCommand(path) {
  return `echo ${STDOUT_BEGIN}; ls -1F --group-directories-first ${shellQuote(path)}; echo ${STDOUT_END};`;
}

/**
 * Unescape the Python-repr escapes the bash tool applies to stdout
 * (\\n, \\t, \\r, \\', \\", \\\\). Unknown escapes pass through verbatim.
 * @param {string} s
 */
export function unescapeRepr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'n') { out += '\n'; i++; continue; }
      if (n === 't') { out += '\t'; i++; continue; }
      if (n === 'r') { out += '\r'; i++; continue; }
      if (n === '\\') { out += '\\'; i++; continue; }
      if (n === "'") { out += "'"; i++; continue; }
      if (n === '"') { out += '"'; i++; continue; }
    }
    out += c;
  }
  return out;
}

/**
 * Extract the marked stdout region from a raw bash-tool result text. Tolerates
 * the CmdResult repr wrapper and trailing garbage; returns null when the
 * markers are absent (unparseable result).
 * @param {string} rawText
 */
export function extractMarkedStdout(rawText) {
  if (typeof rawText !== 'string') return null;
  const begin = rawText.indexOf(STDOUT_BEGIN);
  const end = rawText.lastIndexOf(STDOUT_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  const inner = rawText.slice(begin + STDOUT_BEGIN.length, end);
  return unescapeRepr(inner).replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * Parse `ls -1F` lines into file entries. Classifier suffixes: `/` dir,
 * `@` symlink, `*` executable, `|`/`=`/`>` other; no suffix = plain file.
 * `parentPath` is the listed directory (used to build absolute entry paths).
 *
 * @param {string} stdout
 * @param {string} parentPath
 * @returns {Array<{name: string, path: string, kind: 'dir'|'file'|'symlink'|'exec'|'other'}>}
 */
export function parseLsEntries(stdout, parentPath) {
  if (typeof stdout !== 'string' || !parentPath) return [];
  const parent = parentPath.replace(/\/+$/, '');
  const entries = [];
  for (let line of stdout.split('\n')) {
    line = line.replace(/\r$/, '');
    if (!line.trim()) continue;
    let kind = 'file';
    const m = line.match(/([/@*|=>])$/);
    if (m) {
      line = line.slice(0, -1);
      kind = { '/': 'dir', '@': 'symlink', '*': 'exec', '|': 'other', '=': 'other', '>': 'other' }[m[1]] || 'other';
    }
    const name = line.trim();
    if (!name || name === '.' || name === '..') continue;
    entries.push({ name, path: `${parent}/${name}`, kind });
  }
  return entries;
}

/**
 * Parse the `name:`/`description:` fields out of a SKILL.md head (the
// frontmatter between the opening and closing `---` lines). Handles inline
 * and block (`|`) descriptions. Missing name falls back to null (caller
 * substitutes the folder name); description defaults to ''.
 *
 * @param {string} head
 * @returns {{ name: string | null, description: string }}
 */
export function parseSkillFrontmatter(head) {
  const out = { name: null, description: '' };
  if (typeof head !== 'string') return out;
  const lines = head.split('\n');
  let started = false;
  let descBlock = false;
  for (const line of lines) {
    if (!started) {
      if (line.trim() === '---') started = true;
      continue;
    }
    if (line.trim() === '---') break; // frontmatter end
    if (descBlock) {
      // Block-scalar description: indented lines until the next top-level key.
      if (/^\s+\S/.test(line)) { out.description += (out.description ? '\n' : '') + line.trim(); continue; }
      descBlock = false;
    }
    const nm = line.match(/^name:\s*(.*)$/);
    if (nm) { out.name = nm[1].trim().slice(0, 100) || null; continue; }
    const dm = line.match(/^description:\s*(.*)$/);
    if (dm) {
      const rest = dm[1].trim();
      if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') { descBlock = true; continue; }
      out.description = rest;
      continue;
    }
  }
  return out;
}

/**
 * Parse the full skills bundle (the ##SKILL-delimited output of
 * skillsListCommand) into a report: the skill entries (sorted by name) plus
 * the total folder count from the ##SKILL_COUNT line (#73 — lets the UI say
 * "+N more" when folders were skipped). Folders whose frontmatter lacks a
 * name use the folder name; entries with no parseable SKILL.md head at all
 * are skipped. Missing markers (truncated/unparseable listing) yield an
 * empty report with totalFolders null — callers surface that honestly.
 *
 * @param {string} rawText bash tool result text
 * @returns {{ skills: Array<{id: string, name: string, description: string}>, totalFolders: number | null }}
 */
export function parseSkillsBundle(rawText) {
  const stdout = extractMarkedStdout(rawText);
  if (stdout == null) return { skills: [], totalFolders: null };
  const skills = [];
  let totalFolders = null;
  let current = null;
  let head = [];
  const flush = () => {
    if (!current) return;
    const fm = parseSkillFrontmatter(head.join('\n'));
    // Emit whenever the SKILL.md head carried ANY content — a folder whose
    // frontmatter is missing/unparseable is still a runnable skill (folder
    // name as the label). A folder with no head at all (marker only, e.g.
    // the head dump was cut short) is skipped.
    if (fm.name !== null || fm.description || head.some((l) => l.trim())) {
      skills.push({
        id: current,
        name: fm.name || current,
        description: fm.description.replace(/\s+/g, ' ').trim().slice(0, SKILL_DESC_MAX),
      });
    }
    current = null;
    head = [];
  };
  for (const line of stdout.split('\n')) {
    const cm = line.match(/^##SKILL_COUNT\s+(\d+)$/);
    if (cm) { totalFolders = parseInt(cm[1], 10); continue; }
    const m = line.match(/^##SKILL\s+(\/\S+)$/);
    if (m) {
      flush();
      current = m[1].split('/').pop() || m[1];
      continue;
    }
    if (current) head.push(line);
  }
  flush();
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, totalFolders };
}

/**
 * Case-insensitive contains filter over an entries list (name + description
 * for skills; name + path for files) — the popup's live filter.
 * @param {Array<{name: string}>} entries
 * @param {string} q
 */
export function filterPickerEntries(entries, q) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return Array.isArray(entries) ? entries.slice() : [];
  return (entries || []).filter((e) => {
    const hay = `${e.name || ''} ${e.description || ''} ${e.path || ''} ${e.id || ''}`.toLowerCase();
    return hay.includes(needle);
  });
}

/**
 * Prompt lines for the `## Skills to Run` section (one per picked skill).
 * The skill-folder path is included so Zo reads its own SKILL.md server-side.
 * @param {Array<{id: string, name: string, description?: string}>} skills
 * @returns {string[]}
 */
export function buildSkillLines(skills) {
  const lines = [];
  for (const s of (skills || [])) {
    if (!s || typeof s !== 'object' || !s.name) continue;
    const desc = String(s.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const folder = s.id ? ` (skill folder: ${SKILLS_DIR}/${s.id})` : '';
    lines.push(`- "${s.name}"${desc ? ` — ${desc}` : ''}${folder}`);
  }
  return lines;
}

/**
 * Prompt lines for the `## Referenced Files` section (paths only — Zo
 * resolves content server-side with its own file tools).
 * @param {Array<{path: string}>} files
 * @returns {string[]}
 */
export function buildFileLines(files) {
  const lines = [];
  for (const f of (files || [])) {
    if (!f || typeof f !== 'object' || !f.path) continue;
    lines.push(`- ${f.path}`);
  }
  return lines;
}
