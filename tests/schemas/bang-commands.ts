import { z } from "zod";

// Discriminated union for parseBangCommand() output, keyed on `kind`.
// Every code path in extension/lib/bang-commands.js must produce one of these.

const Passthrough = z.object({
  handled: z.literal(false),
  kind: z.literal("passthrough"),
});

const InlineReply = z.object({
  handled: z.literal(true),
  kind: z.literal("inline"),
  inlineReply: z.string().min(1),
});

const Save = z.object({
  handled: z.literal(true),
  kind: z.literal("save"),
  isSave: z.literal(true),
  savePath: z.string(),
});

// !auto — create a Zo automation/agent from the page
const Automation = z.object({
  handled: z.literal(true),
  kind: z.literal("automation"),
  isAuto: z.literal(true),
  instruction: z.string(),
});

// !query / !data — natural-language DuckDB query
const DuckdbQuery = z.object({
  handled: z.literal(true),
  kind: z.literal("duckdb"),
  isDuckdb: z.literal(true),
  naturalQuery: z.string(),
});

const ExpandedQuery = z.object({
  handled: z.literal(true),
  kind: z.literal("command"),
  query: z.string().min(1),
  mode: z.string().nullable(),
});

// !context / !dom / !ctx — attach full page context for one turn (no mode switch)
const ContextAttach = z.object({
  handled: z.literal(true),
  kind: z.literal("context"),
  isContext: z.literal(true),
  query: z.string().min(1),
});

// !handoff <goal> — delegate the goal as an unattended read-only run (Lane E)
const Handoff = z.object({
  handled: z.literal(true),
  kind: z.literal("handoff"),
  isHandoff: z.literal(true),
  query: z.string().min(1), // the goal
});

export const BangCommandResultSchema = z.discriminatedUnion("kind", [
  Passthrough,
  InlineReply,
  Save,
  Automation,
  DuckdbQuery,
  ExpandedQuery,
  ContextAttach,
  Handoff,
]);

export type BangCommandResult = z.infer<typeof BangCommandResultSchema>;

export const BANG_COMMAND_NAMES = [
  "summarize",
  "extract",
  "research",
  "qa",
  "ask",
  "fill",
  "skills",
  "skill",
  "save",
  "auto",
  "query",
  "data",
  "context",
  "dom",
  "ctx",
  "handoff",
] as const;
