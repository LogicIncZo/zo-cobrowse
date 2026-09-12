import { z } from "zod";

// qa-findings schema — the QA agent's findings-queue contract (0.2.8 bash
// tooling). One markdown file per finding in docs/qa/findings/; the
// frontmatter is the machine-validated half, the body carries repro +
// evidence. Presence in the dir = unhandled; fixing or filing on GitHub
// deletes the file. Spec: docs/superpowers/specs/2026-09-10-qa-agent-design.md

/** Stable kebab-case key, `qa-` prefixed — the dedup unit. */
export const FindingKeySchema = z
  .string()
  .regex(/^qa-[a-z0-9-]+$/, "key must match qa-kebab-case (it is the dedup unit)");

export const SeveritySchema = z.enum(["P1", "P2", "P3", "P3-flake"]);

/** Which lane produced the finding. */
export const SourceSchema = z.enum(["matrix", "explorer", "review"]);

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "found must be YYYY-MM-DD");

/** The frontmatter block every finding file must carry. */
export const FindingFrontmatterSchema = z.object({
  key: FindingKeySchema,
  title: z.string().min(1),
  severity: SeveritySchema,
  /** Surface name matching docs/qa/manual-panel-checklist section names. */
  surface: z.string().min(1),
  source: SourceSchema,
  found: IsoDateSchema,
});
export type FindingFrontmatter = z.infer<typeof FindingFrontmatterSchema>;

/** A fully parsed finding file: valid frontmatter + non-empty body. */
export const ParsedFindingSchema = FindingFrontmatterSchema.extend({
  body: z.string().min(1),
});
export type ParsedFinding = z.infer<typeof ParsedFindingSchema>;

/** parseFindingFile() result — discriminated on `ok`. */
export const ParseResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), finding: ParsedFindingSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type ParseResult = z.infer<typeof ParseResultSchema>;

/** validateFindingsDir() result — everything the gate and CI need. */
export const DirReportSchema = z.object({
  dir: z.string(),
  fileCount: z.number().int().min(0),
  findings: z.array(ParsedFindingSchema),
  errors: z.array(z.object({ file: z.string(), error: z.string() })),
  duplicateKeys: z.array(z.string()),
});
export type DirReport = z.infer<typeof DirReportSchema>;
