// One-off live probe for #52 — confirm the MCP read_file tool's response shape
// (plain text vs bash-style Python-repr wrapper) before wiring the pull action.
// bun tests/test-prompts/probe-read-file.ts  (uses ZO_API_KEY from .env)
import { readFileSync } from 'node:fs';

const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const key = env.match(/^ZO_API_KEY=(.*)$/m)?.[1]?.trim();
if (!key) { console.error('no ZO_API_KEY'); process.exit(1); }

const URL_ = 'https://api.zo.computer/mcp';
let sessionId = null;

async function post(body, expectSession = false) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body,
  });
  if (expectSession) sessionId = r.headers.get('mcp-session-id');
  const text = await r.text();
  // streamable HTTP may answer as SSE — take the data: payload
  if (text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
    }
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

const init = await post(rpc(1, 'initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'zo-cobrowse-probe', version: '0.0.1' },
}), true);
console.log('== initialize ==\n', JSON.stringify(init).slice(0, 300));
await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

// seed a probe file via bash
const seed = await post(rpc(2, 'tools/call', {
  name: 'bash',
  arguments: { cmd: `echo 'zo-cobrowse #52 probe content line' > /home/workspace/zo-probe-52.md && echo seeded` },
}));
console.log('== seed ==\n', JSON.stringify(seed).slice(0, 400));

// THE probe: read_file
const rf = await post(rpc(3, 'tools/call', {
  name: 'read_file',
  arguments: { target_file: '/home/workspace/zo-probe-52.md' },
}));
console.log('== read_file raw ==\n', JSON.stringify(rf, null, 1));

// missing-file behavior
const miss = await post(rpc(4, 'tools/call', {
  name: 'read_file',
  arguments: { target_file: '/home/workspace/zo-probe-does-not-exist.md' },
}));
console.log('== read_file missing ==\n', JSON.stringify(miss, null, 1).slice(0, 1200));

// cleanup
const rm = await post(rpc(5, 'tools/call', {
  name: 'bash',
  arguments: { cmd: `rm -f /home/workspace/zo-probe-52.md && echo cleaned` },
}));
console.log('== cleanup ==\n', JSON.stringify(rm).slice(0, 200));
