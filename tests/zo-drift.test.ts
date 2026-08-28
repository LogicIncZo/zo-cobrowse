// Drift-gate contract tests: the pure comparison half (lib.ts) plus sanity
// checks that the committed baselines still satisfy the extension's known
// dependencies (so a corrupted re-pin fails here, not at release time).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ASK_REQUEST_FIELDS,
  REQUIRED_MCP_TOOLS,
  REQUIRED_OPENAPI_PATHS,
  VISION_FIELD,
  classifyOpenApiDrift,
  classifyToolDrift,
  diffOpenApi,
  diffTools,
  parseToolSnapshot,
  stableStringify,
  type DriftFinding,
  type ToolEntry,
} from '../scripts/zo-drift/lib.ts';

const tool = (name: string, schema: unknown = { type: 'object' }): ToolEntry => ({ name, inputSchema: schema });

describe('stableStringify', () => {
  test('key order never changes the output', () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(stableStringify({ b: { d: 3, c: 2 }, a: 1 }));
  });

  test('arrays keep order, primitives stringify', () => {
    expect(stableStringify([1, { z: true, a: null }])).toBe('[1,{"a":null,"z":true}]');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(null)).toBe('null');
  });
});

describe('parseToolSnapshot', () => {
  test('accepts the upstream {tools:[…]} shape', () => {
    expect(parseToolSnapshot({ tools: [{ name: 'bash', inputSchema: { type: 'object' } }] })).toHaveLength(1);
  });

  test('rejects malformed snapshots with a clear error', () => {
    expect(() => parseToolSnapshot({ nope: true })).toThrow(/mcp-tools\.json/);
    expect(() => parseToolSnapshot({ tools: [{ description: 'nameless' }] })).toThrow();
  });
});

describe('diffTools', () => {
  test('detects added / removed / schema-changed tools', () => {
    const base = [tool('bash', { type: 'object', properties: { cmd: { type: 'string' } } }), tool('read_file'), tool('old_tool')];
    const curr = [
      tool('bash', { type: 'object', properties: { cmd: { type: 'string' }, cwd: { type: 'string' } } }),
      tool('read_file'),
      tool('new_tool'),
    ];
    const diff = diffTools(base, curr);
    expect(diff.added).toEqual(['new_tool']);
    expect(diff.removed).toEqual(['old_tool']);
    expect(diff.changed.map((c) => c.name)).toEqual(['bash']);
  });

  test('inputSchema key reordering is NOT drift', () => {
    const base = [tool('bash', { properties: { cmd: { type: 'string' } }, type: 'object' })];
    const curr = [tool('bash', { type: 'object', properties: { cmd: { type: 'string' } } })];
    expect(diffTools(base, curr).changed).toEqual([]);
  });
});

describe('classifyToolDrift', () => {
  test('removal/change of a required tool is hard drift', () => {
    const findings = classifyToolDrift({ added: [], removed: REQUIRED_MCP_TOOLS.slice(), changed: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ key: 'mcp:tool-removed:bash', severity: 'hard' });
    const changed = classifyToolDrift({
      added: [],
      removed: [],
      changed: [{ name: 'bash', before: '{}', after: '{"x":1}' }],
    });
    expect(changed[0]).toMatchObject({ key: 'mcp:tool-changed:bash', severity: 'hard' });
  });

  test('removal of a tool we do not call is soft drift with a stable key', () => {
    const findings = classifyToolDrift({ added: [], removed: ['generate_video'], changed: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ key: 'mcp:tool-removed:generate_video', severity: 'soft' });
  });

  test('additions collapse into one soft finding', () => {
    const findings = classifyToolDrift({ added: ['a_tool', 'b_tool'], removed: [], changed: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ key: 'mcp:tools-added', severity: 'soft' });
    expect(findings[0].details).toContain('a_tool');
  });
});

// Synthetic OpenAPI docs — /zo/ask via the same $ref indirection upstream uses.
function askDoc(fields: Record<string, unknown>, paths: string[], withVisionField = true) {
  return {
    paths: Object.fromEntries(
      paths.map((p) => [
        p,
        { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ZoAskRequest' } } } } } },
      ]),
    ),
    components: {
      schemas: {
        ZoAskRequest: { properties: fields },
        ModelCatalogResponse: withVisionField ? { properties: { [VISION_FIELD]: { type: 'boolean' } } } : { properties: {} },
      },
    },
  };
}

describe('diffOpenApi', () => {
  const base = askDoc(
    Object.fromEntries(ASK_REQUEST_FIELDS.map((f) => [f, { type: 'string' }])),
    REQUIRED_OPENAPI_PATHS.slice(),
  );

  test('identical docs produce a clean diff', () => {
    const diff = diffOpenApi(base, askDoc(Object.fromEntries(ASK_REQUEST_FIELDS.map((f) => [f, { type: 'string' }])), REQUIRED_OPENAPI_PATHS.slice()));
    expect(diff).toEqual({ pathsAdded: [], pathsRemoved: [], askFieldsAdded: [], askFieldsRemoved: [], visionFieldMissing: false });
  });

  test('detects path removal, ask-field removal, and vision-field disappearance', () => {
    const curr = askDoc({ input: { type: 'string' } }, ['/zo/ask', '/models/available'], false);
    const diff = diffOpenApi(base, curr);
    expect(diff.pathsRemoved).toEqual(['/models/catalog', '/personas/available']);
    expect(diff.askFieldsRemoved).toEqual(['conversation_id', 'model_name', 'persona_id']);
    expect(diff.visionFieldMissing).toBe(true);
  });

  test('detects additions', () => {
    const curr = askDoc({ ...Object.fromEntries(ASK_REQUEST_FIELDS.map((f) => [f, { type: 'string' }])), memory_mode: { type: 'string' } }, [
      ...REQUIRED_OPENAPI_PATHS,
      '/memory/search',
    ]);
    const diff = diffOpenApi(base, curr);
    expect(diff.pathsAdded).toEqual(['/memory/search']);
    expect(diff.askFieldsAdded).toEqual(['memory_mode']);
    expect(diff.visionFieldMissing).toBe(false);
  });
});

describe('classifyOpenApiDrift', () => {
  test('removed paths and ask fields are hard; additions are soft', () => {
    const findings = classifyOpenApiDrift({
      pathsAdded: ['/new/thing'],
      pathsRemoved: ['/models/catalog'],
      askFieldsAdded: ['memory_mode'],
      askFieldsRemoved: ['persona_id'],
      visionFieldMissing: false,
    });
    const byKey = Object.fromEntries(findings.map((f) => [f.key, f]));
    expect(byKey['openapi:path-removed:/models/catalog'].severity).toBe('hard');
    expect(byKey['openapi:ask-field-removed:persona_id'].severity).toBe('hard');
    expect(byKey['openapi:paths-added'].severity).toBe('soft');
    expect(byKey['openapi:ask-fields-added'].severity).toBe('soft');
  });

  test('missing vision field is hard drift (lib/vision.js gates on it)', () => {
    const findings = classifyOpenApiDrift({
      pathsAdded: [],
      pathsRemoved: [],
      askFieldsAdded: [],
      askFieldsRemoved: [],
      visionFieldMissing: true,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ key: 'openapi:vision-field-missing', severity: 'hard' });
  });
});

// ── Committed baselines must satisfy the extension's known dependencies ────
describe('pinned baselines', () => {
  const mcpSnapshot = JSON.parse(readFileSync('scripts/zo-drift/baseline/mcp-tools.json', 'utf8'));
  const openapi = JSON.parse(readFileSync('scripts/zo-drift/baseline/openapi.json', 'utf8'));

  test('mcp-tools.json parses and contains every required tool', () => {
    const tools = parseToolSnapshot(mcpSnapshot);
    expect(tools.length).toBeGreaterThanOrEqual(90);
    const names = tools.map((t) => t.name);
    for (const required of REQUIRED_MCP_TOOLS) expect(names).toContain(required);
    // neighbors we are likely to build against next (#28 read_file follow-up)
    expect(names).toContain('read_file');
    expect(names).toContain('list_directory');
  });

  test('openapi.json parses, has every required path, ask fields, and the vision field', () => {
    const clean = diffOpenApi(openapi, openapi);
    expect(clean.pathsRemoved).toEqual([]);
    expect(clean.askFieldsRemoved).toEqual([]);
    expect(clean.visionFieldMissing).toBe(false);
    const paths = Object.keys(openapi.paths);
    for (const p of REQUIRED_OPENAPI_PATHS) expect(paths).toContain(p);
  });

  test('a fresh fetch equal to baseline yields zero findings (classify pass)', () => {
    const toolDiff = diffTools(parseToolSnapshot(mcpSnapshot), parseToolSnapshot(mcpSnapshot));
    const findings: DriftFinding[] = [...classifyToolDrift(toolDiff), ...classifyOpenApiDrift(diffOpenApi(openapi, openapi))];
    expect(findings).toEqual([]);
  });
});
