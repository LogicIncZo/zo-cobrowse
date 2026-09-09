import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE_SCRIPT = "scripts/qa/qa-gate.sh";
const VALID = `---
key: qa-gate-fixture
title: fixture finding
severity: P2
surface: chat-tabs
source: review
found: 2026-09-10
---
body
`;

function runGate(dir: string) {
  const p = Bun.spawnSync(["bash", GATE_SCRIPT], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, QA_FINDINGS_DIR: dir },
  });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

describe("qa-gate.sh", () => {
  test("empty dir passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-gate-"));
    expect(runGate(dir).code).toBe(0);
  });

  test("missing dir passes (fresh clone)", () => {
    expect(runGate(join(tmpdir(), `qa-gate-missing-${Date.now()}`)).code).toBe(0);
  });

  test("a finding blocks the gate and is listed", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-gate-"));
    writeFileSync(join(dir, "qa-gate-fixture.md"), VALID);
    const r = runGate(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("qa-gate-fixture.md");
  });

  test("a malformed finding blocks the gate (validation leg)", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-gate-"));
    writeFileSync(join(dir, "bad.md"), "no fence");
    expect(runGate(dir).code).toBe(1);
  });
});
