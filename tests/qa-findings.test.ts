import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DirReportSchema,
  FindingFrontmatterSchema,
  ParsedFindingSchema,
  ParseResultSchema,
  SeveritySchema,
  SourceSchema,
} from "./schemas/qa-findings";
import type { DirReport, FindingFrontmatter } from "./schemas/qa-findings";
import { parseFindingFile, validateFindingsDir } from "../scripts/qa/validate-findings";

export const VALID_FRONTMATTER: FindingFrontmatter = {
  key: "qa-chat-tabs-close-mid-stream",
  title: "Closing a chat tab mid-stream orphans the stream session",
  severity: "P1",
  surface: "chat-tabs",
  source: "explorer",
  found: "2026-09-10",
};

const VALID_FILE = `---
key: qa-chat-tabs-close-mid-stream
title: Closing a chat tab mid-stream orphans the stream session
severity: P1
surface: chat-tabs
source: explorer
found: 2026-09-10
---
Closing the tab while its stream runs kills the stream and the conversation
never receives the final answer.

Repro: start a slow ask, middle-click the tab to close it while streaming.
`;

describe("qa-findings schema", () => {
  test("accepts a valid frontmatter object", () => {
    expect(FindingFrontmatterSchema.parse(VALID_FRONTMATTER)).toEqual(VALID_FRONTMATTER);
  });

  test("rejects a bad key (dedup unit must be qa-kebab-case)", () => {
    expect(
      FindingFrontmatterSchema.safeParse({ ...VALID_FRONTMATTER, key: "Chat Tabs Close" }).success,
    ).toBe(false);
  });

  test("rejects unknown severity and source enums", () => {
    expect(SeveritySchema.safeParse("P0").success).toBe(false);
    expect(SourceSchema.safeParse("manual").success).toBe(false);
  });

  test("rejects a malformed found date", () => {
    expect(FindingFrontmatterSchema.safeParse({ ...VALID_FRONTMATTER, found: "09/10/2026" }).success).toBe(false);
  });

  test("body must be non-empty on a parsed finding", () => {
    expect(ParsedFindingSchema.safeParse({ ...VALID_FRONTMATTER, body: "" }).success).toBe(false);
    expect(ParsedFindingSchema.safeParse({ ...VALID_FRONTMATTER, body: "repro steps" }).success).toBe(true);
  });

  test("DirReport shape round-trips", () => {
    const report: DirReport = {
      dir: "docs/qa/findings",
      fileCount: 1,
      findings: [{ ...VALID_FRONTMATTER, body: "repro" }],
      errors: [],
      duplicateKeys: [],
    };
    expect(DirReportSchema.parse(report)).toEqual(report);
  });

  test("ParseResult discriminates on ok", () => {
    expect(ParseResultSchema.safeParse({ ok: false, error: "no frontmatter" }).success).toBe(true);
    expect(ParseResultSchema.safeParse({ ok: true, finding: { ...VALID_FRONTMATTER, body: "b" } }).success).toBe(true);
    expect(ParseResultSchema.safeParse({ ok: true, finding: { ...VALID_FRONTMATTER } }).success).toBe(false);
  });
});

describe("parseFindingFile", () => {
  test("parses a valid finding (frontmatter + body)", () => {
    const r = parseFindingFile(VALID_FILE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.finding.key).toBe("qa-chat-tabs-close-mid-stream");
  });

  test("rejects missing frontmatter", () => {
    const r = parseFindingFile("just some text, no fence");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("frontmatter");
  });

  test("rejects an unterminated frontmatter fence", () => {
    const r = parseFindingFile("---\nkey: qa-x\n");
    expect(r.ok).toBe(false);
  });

  test("rejects unknown frontmatter keys (typo guard)", () => {
    const r = parseFindingFile(VALID_FILE.replace("severity:", "severities:"));
    expect(r.ok).toBe(false);
  });

  test("rejects empty body", () => {
    const r = parseFindingFile(VALID_FILE.slice(0, VALID_FILE.indexOf("---\n", 4) + 4));
    expect(r.ok).toBe(false);
  });
});

describe("validateFindingsDir", () => {
  test("empty dir → zero counts, no errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-findings-"));
    const report = validateFindingsDir(dir);
    expect(report.fileCount).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.duplicateKeys).toEqual([]);
  });

  test("valid files pass; duplicate keys are reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-findings-"));
    writeFileSync(join(dir, "a.md"), VALID_FILE);
    writeFileSync(join(dir, "b.md"), VALID_FILE.replace("Closing a chat tab", "Shutting a chat tab"));
    const report = validateFindingsDir(dir);
    expect(report.fileCount).toBe(2);
    expect(report.duplicateKeys).toEqual(["qa-chat-tabs-close-mid-stream"]);
  });

  test("malformed files land in errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-findings-"));
    writeFileSync(join(dir, "bad.md"), "no fence here");
    const report = validateFindingsDir(dir);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].file).toBe("bad.md");
  });

  test("missing dir is an empty queue, not a crash", () => {
    const report = validateFindingsDir(join(tmpdir(), `qa-findings-missing-${Date.now()}`));
    expect(report.fileCount).toBe(0);
  });
});
