// Bang (!) commands — pure logic, no chrome.* or DOM dependencies.
// Imported by sidepanel.js (ESM) and directly by tests.

export const BANG_COMMANDS = {
  summarize: {
    // Summarize/Research merged into Ask (2026-08 rationalization) — the
    // canned query carries the summarizing intent; Ask is the reader Mode.
    mode: 'ask',
    label: 'Summarize',
    desc: 'Condense the page into a concise summary',
    buildQuery: () => 'Summarize this page concisely.',
  },
  extract: {
    mode: 'extract',
    label: 'Extract',
    desc: 'Extract structured data (tables, lists, contacts, prices)',
    buildQuery: (args) => args ? `Extract ${args} from this page as structured data.` : 'Extract all structured data from this page.',
  },
  research: {
    mode: 'ask',
    label: 'Research',
    desc: 'Deep research on the page topic',
    buildQuery: (args) => args ? `Do deep research on: ${args}` : 'Do deep research on this page topic.',
  },
  ask: {
    mode: 'ask',
    label: 'Ask',
    desc: 'Answer a specific question about the page',
    buildQuery: (args) => args || 'What is this page about?',
  },
  fill: {
    mode: null,
    label: 'Fill',
    desc: 'Ask Zo to fill editable fields on the page',
    buildQuery: (args) => args ? `Fill the form on this page: ${args}` : 'Fill the editable form fields on this page with reasonable test data.',
  },
  skills: {
    mode: null,
    label: 'Skills',
    desc: 'List available Zo skills',
    buildQuery: () => 'List all your available skills. For each skill, give me its name and a one-line description of what it does. Format as a bulleted list.',
  },
  skill: {
    mode: null,
    label: 'Run Skill',
    desc: 'Run a Zo skill on the current page (e.g., !skill cc-awareness-video)',
    buildQuery: (args) => args
      ? `Run the skill named "${args}" using the content from this page as input.`
      : 'Please specify a skill name. Type `!skills` to see available skills.',
  },
  autos: {
    mode: null,
    label: 'Automations',
    desc: 'List your scheduled Zo automations',
    buildQuery: () => 'List all my scheduled automations with their titles, schedules, and delivery methods.',
  },
};

// Returns { handled, query, mode } or { handled: false }
// If handled is true but query is null, the command produced an inline reply
// (e.g. !help) and sendQuery should abort after showing it.
export function parseBangCommand(rawQuery) {
  if (!rawQuery || rawQuery[0] !== '!') return { handled: false, kind: 'passthrough' };

  const trimmed = rawQuery.slice(1).trim();
  const spaceIdx = trimmed.indexOf(' ');
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  // !help — list commands inline
  if (name === 'help' || name === 'commands' || name === '?') {
    const lines = ['**Quick Commands** (type these in the chat):'];
    for (const [cmd, def] of Object.entries(BANG_COMMANDS)) {
      lines.push(`• \`!${cmd}\` — ${def.desc}`);
    }
    lines.push('• `!context <question>` — Attach this page (text + elements) for one turn, then answer');
    lines.push('• `!save [path]` — Save this page to your Zo workspace as markdown');
    lines.push('• `!auto <instruction>` — Create a scheduled Zo automation');
    lines.push('• `!query <question>` — Natural-language DuckDB query on your data');
    lines.push('• `!help` — Show this list');
    return { handled: true, kind: 'inline', inlineReply: lines.join('\n') };
  }

  // !save — save page to Zo workspace as markdown
  if (name === 'save') {
    const savePath = args || ''; // optional filename/path argument
    return { handled: true, kind: 'save', isSave: true, savePath };
  }

  // !auto — create a Zo automation/agent from the current page (#08)
  if (name === 'auto') {
    const instruction = args || '';
    if (!instruction) {
      return {
        handled: true, kind: 'inline',
        inlineReply: 'Usage: `!auto <instruction>` — e.g., `!auto summarize this page every day at 9am`. Creates a persistent Zo automation that runs on a schedule.',
      };
    }
    return { handled: true, kind: 'automation', isAuto: true, instruction };
  }

  // !query / !data — natural-language DuckDB query (#05)
  if (name === 'query' || name === 'data') {
    const naturalQuery = args;
    if (!naturalQuery) {
      return {
        handled: true, kind: 'inline',
        inlineReply: 'Usage: `!query <question>` — e.g. `!query total UPI volume by month`. Zo translates your question into a DuckDB query against your datasets.',
      };
    }
    return { handled: true, kind: 'duckdb', isDuckdb: true, naturalQuery };
  }

  // !context — attach full page context for THIS one turn only. (Former
  // aliases !dom/!ctx were dropped in the 2026-08 rationalization.) Does NOT
  // switch modes (unlike the `command` kind); the active Mode's tier is what
  // gets attached. The context policy (lib/context-policy.js) keys off
  // kind === 'context' to force an attach, overriding opt-in / send-once.
  if (name === 'context') {
    if (!args) {
      return {
        handled: true, kind: 'inline',
        inlineReply: 'Usage: `!context <question>` — attaches the page (text + elements) to this one turn, then answers. Example: `!context summarize the pricing`.',
      };
    }
    return { handled: true, kind: 'context', isContext: true, query: args };
  }

  // Look up the command
  const cmd = BANG_COMMANDS[name];
  if (!cmd) {
    return {
      handled: true, kind: 'inline',
      inlineReply: `Unknown command: \`!${name}\`. Type \`!help\` to see available commands.`,
    };
  }

  return {
    handled: true, kind: 'command',
    query: cmd.buildQuery(args),
    mode: cmd.mode, // may be null for non-mode commands like !fill
  };
}
