// Pure comparison half of the Zo API drift gate — no fetch, no fs, no env.
// Consumed by check.ts (CI + `bun run check:drift`) and unit-tested by
// tests/zo-drift.test.ts.
//
// What we diff:
//   1. EthanThatOneKid/zocomputer-tools  openapi/mcp-tools.json  — Zo's MCP
//      tool inventory (name + inputSchema per tool), refreshed nightly by
//      their sync workflow.
//   2. EthanThatOneKid/zocomputer-ts     openapi/openapi.json    — Zo's REST
//      surface (/zo/ask, /models/*, /personas/*), regenerated nightly from
//      Zo's public OpenAPI spec.
// A diff alone isn't a verdict: classifyToolDrift / classifyOpenApiDrift turn
// diffs into findings with a stable dedup `key` and a severity — `hard`
// findings break a load-bearing dependency (release gate goes red), `soft`
// findings are upstream churn worth a ticket but not a blocked release.

import { z } from 'zod';

// ── What the extension depends on today ────────────────────────────────────
// background.js POSTs these to /zo/ask (input required, rest conditional).
export const ASK_REQUEST_FIELDS = ['input', 'model_name', 'conversation_id', 'persona_id'] as const;
// lib/vision.js gates tier-3 screenshots on this /models/catalog field.
export const VISION_FIELD = 'supports_images';
// MCP tools invoked at runtime by the extension (composer pickers use bash).
export const REQUIRED_MCP_TOOLS = ['bash'] as const;
// Every path in the REST surface is exercised somewhere (ask, catalog via the
// vision gate, models/available via the picker, personas via the dropdown).
export const REQUIRED_OPENAPI_PATHS = ['/zo/ask', '/models/catalog', '/models/available', '/personas/available'] as const;

// ── Upstream snapshot shapes (validated, not trusted) ──────────────────────
export const ToolEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
});
export const ToolSnapshotSchema = z.object({ tools: z.array(ToolEntrySchema) });

export interface ToolEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
}
export interface ToolDiff {
  added: string[];
  removed: string[];
  changed: Array<{ name: string; before: string; after: string }>;
}

// Key-order-insensitive stringify so upstream re-serialization never reads as drift.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function parseToolSnapshot(snapshot: unknown): ToolEntry[] {
  const parsed = ToolSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error(`mcp-tools.json no longer matches {tools:[{name,inputSchema}]}: ${parsed.error.message}`);
  }
  return parsed.data.tools;
}

export function diffTools(baseline: ToolEntry[], current: ToolEntry[]): ToolDiff {
  const base = new Map(baseline.map((t) => [t.name, t]));
  const curr = new Map(current.map((t) => [t.name, t]));
  const changed: ToolDiff['changed'] = [];
  for (const [name, c] of curr) {
    const b = base.get(name);
    if (!b) continue;
    if (stableStringify(b.inputSchema ?? null) !== stableStringify(c.inputSchema ?? null)) {
      changed.push({
        name,
        before: stableStringify(b.inputSchema ?? null),
        after: stableStringify(c.inputSchema ?? null),
      });
    }
  }
  return {
    added: [...curr.keys()].filter((n) => !base.has(n)).sort(),
    removed: [...base.keys()].filter((n) => !curr.has(n)).sort(),
    changed: changed.sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
}

// ── OpenAPI surface ─────────────────────────────────────────────────────────
export interface OpenApiDiff {
  pathsAdded: string[];
  pathsRemoved: string[];
  askFieldsAdded: string[];
  askFieldsRemoved: string[];
  visionFieldMissing: boolean;
}

function resolveSchemaRef(doc: Record<string, unknown>, schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== 'object') return null;
  const ref = (schema as { $ref?: unknown }).$ref;
  if (typeof ref !== 'string') return schema as Record<string, unknown>;
  const m = ref.match(/^#\/components\/schemas\/(.+)$/);
  const components = doc.components as Record<string, Record<string, unknown>> | undefined;
  const target = m ? components?.schemas?.[m[1]] : undefined;
  return (target ?? null) as Record<string, unknown> | null;
}

function hasPropertyDeep(value: unknown, prop: string, depth = 0): boolean {
  if (depth > 24 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasPropertyDeep(v, prop, depth + 1));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === prop) return true;
    if (hasPropertyDeep(v, prop, depth + 1)) return true;
  }
  return false;
}

export function diffOpenApi(baseline: unknown, current: unknown): OpenApiDiff {
  const bDoc = baseline as Record<string, unknown>;
  const cDoc = current as Record<string, unknown>;
  const bPaths = Object.keys((bDoc.paths ?? {}) as object).sort();
  const cPaths = Object.keys((cDoc.paths ?? {}) as object).sort();

  const askProps = (doc: Record<string, unknown>): string[] => {
    const op = ((doc.paths as Record<string, unknown>)?.['/zo/ask'] as Record<string, unknown>)?.post as
      | Record<string, unknown>
      | undefined;
    const body = ((op?.requestBody as Record<string, unknown>)?.content as Record<string, unknown>)?.[
      'application/json'
    ] as Record<string, unknown> | undefined;
    const schema = resolveSchemaRef(doc, body?.schema);
    const props = (schema?.properties ?? {}) as object;
    return Object.keys(props).sort();
  };

  const bAsk = new Set(askProps(bDoc));
  const cAsk = new Set(askProps(cDoc));

  return {
    pathsAdded: cPaths.filter((p) => !bPaths.includes(p)),
    pathsRemoved: bPaths.filter((p) => !cPaths.includes(p)),
    askFieldsAdded: [...cAsk].filter((f) => !bAsk.has(f)),
    askFieldsRemoved: [...bAsk].filter((f) => !cAsk.has(f)),
    visionFieldMissing: hasPropertyDeep(baseline, VISION_FIELD) && !hasPropertyDeep(current, VISION_FIELD),
  };
}

// ── Findings ────────────────────────────────────────────────────────────────
export interface DriftFinding {
  /** Stable identity for ticket dedup — never reword, only add new keys. */
  key: string;
  severity: 'hard' | 'soft';
  title: string;
  details: string;
}

export function classifyToolDrift(diff: ToolDiff, required: ReadonlyArray<string> = REQUIRED_MCP_TOOLS): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const name of diff.removed) {
    const hard = required.includes(name);
    findings.push({
      key: `mcp:tool-removed:${name}`,
      severity: hard ? 'hard' : 'soft',
      title: `Zo MCP tool removed: ${name}`,
      details: `\`${name}\` is no longer in Zo's MCP tools/list${hard ? ' — **the extension calls this tool at runtime**' : ''}.`,
    });
  }
  for (const c of diff.changed) {
    const hard = required.includes(c.name);
    findings.push({
      key: `mcp:tool-changed:${c.name}`,
      severity: hard ? 'hard' : 'soft',
      title: `Zo MCP tool schema changed: ${c.name}`,
      details: `\`${c.name}\` inputSchema differs from the pinned baseline${hard ? ' — **the extension calls this tool at runtime**' : ''}.\n\n- before: \`${c.before.slice(0, 600)}\`\n- after: \`${c.after.slice(0, 600)}\``,
    });
  }
  if (diff.added.length > 0) {
    const list = diff.added.map((n) => `- \`${n}\``).join('\n');
    findings.push({
      key: 'mcp:tools-added',
      severity: 'soft',
      title: `Zo MCP tools added (${diff.added.length})`,
      details: `New tools on Zo's MCP server — candidates for future features, no action required:\n${list}`,
    });
  }
  return findings;
}

export function classifyOpenApiDrift(diff: OpenApiDiff): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const p of diff.pathsRemoved) {
    const hard = (REQUIRED_OPENAPI_PATHS as ReadonlyArray<string>).includes(p);
    findings.push({
      key: `openapi:path-removed:${p}`,
      severity: hard ? 'hard' : 'soft',
      title: `Zo REST endpoint removed: ${p}`,
      details: `\`${p}\` is gone from Zo's OpenAPI surface${hard ? ' — **the extension depends on this endpoint**' : ''}.`,
    });
  }
  if (diff.pathsAdded.length > 0) {
    findings.push({
      key: 'openapi:paths-added',
      severity: 'soft',
      title: `Zo REST endpoints added (${diff.pathsAdded.length})`,
      details: `New endpoints on Zo's API — candidate surface, no action required:\n${diff.pathsAdded.map((p) => `- \`${p}\``).join('\n')}`,
    });
  }
  for (const f of diff.askFieldsRemoved) {
    findings.push({
      key: `openapi:ask-field-removed:${f}`,
      severity: 'hard',
      title: `/zo/ask request field removed: ${f}`,
      details: `\`${f}\` is no longer accepted by POST /zo/ask${(ASK_REQUEST_FIELDS as ReadonlyArray<string>).includes(f) ? ' — **background.js sends this field**' : ''}.`,
    });
  }
  if (diff.askFieldsAdded.length > 0) {
    findings.push({
      key: 'openapi:ask-fields-added',
      severity: 'soft',
      title: `/zo/ask request fields added (${diff.askFieldsAdded.length})`,
      details: `New accepted fields — candidate capabilities, no action required:\n${diff.askFieldsAdded.map((f) => `- \`${f}\``).join('\n')}`,
    });
  }
  if (diff.visionFieldMissing) {
    findings.push({
      key: 'openapi:vision-field-missing',
      severity: 'hard',
      title: `Catalog field missing: ${VISION_FIELD}`,
      details: `\`${VISION_FIELD}\` no longer appears anywhere in the OpenAPI document — **lib/vision.js gates tier-3 screenshots on it**. The vision gate is blind until this is triaged.`,
    });
  }
  return findings;
}

export interface DriftReport {
  checkedAt: string;
  sources: Record<string, string>;
  error?: string;
  findings: DriftFinding[];
}
