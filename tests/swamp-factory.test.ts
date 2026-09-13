import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  FactoryDefSchema,
  type FactoryDef,
  type Gate,
  type Stage,
} from "./schemas/swamp-factory";

// The committed Swamp factory definition (scripts/swamp/factory.yaml) is a
// standing improvement loop: items flow intake → implement → verify → review
// → merge forever, and releases are owner-called items, never a per-fix
// ritual. This test is the regression net for hand edits: the machine must
// stay structurally sound and keep its load-bearing gates (human approvals on
// merge/release/abort, evidence-gated verify + release commands, review
// findings blocking the merge) so an agent can never walk the loop around
// them. Runtime truth is `swamp model method run zo-loop validate`; this runs
// in plain `bun run verify`.

const FACTORY_PATH = join(import.meta.dir, "..", "scripts", "swamp", "factory.yaml");

const def: FactoryDef = FactoryDefSchema.parse(parse(readFileSync(FACTORY_PATH, "utf8")));

const stageById = new Map<string, Stage>(def.stages.map((s) => [s.id, s]));

function stage(id: string): Stage {
  const s = stageById.get(id);
  if (!s) throw new Error(`missing stage ${id}`);
  return s;
}

function transition(sourceId: string, name: string) {
  const t = stage(sourceId).transitions?.find((t) => t.name === name);
  if (!t) throw new Error(`stage ${sourceId} has no transition ${name}`);
  return t;
}

function gatesOfType(sourceId: string, transitionName: string, type: Gate["type"]): Gate[] {
  return (transition(sourceId, transitionName).gates ?? []).filter((g) => g.type === type);
}

function gateIds(sourceId: string, transitionName: string, type: Gate["type"]): string[] {
  return gatesOfType(sourceId, transitionName, type).map((g) => (g as any).config.id);
}

function requireField(sourceId: string, transitionName: string, evidence: string) {
  const g = gatesOfType(sourceId, transitionName, "evidence-recorded").find(
    (g) => (g as any).config.name === evidence,
  );
  if (!g) throw new Error(`${sourceId}:${transitionName} has no ${evidence} gate`);
  return (g as any).config.requireField;
}

describe("swamp factory definition", () => {
  it("has exactly one intake stage and the terminal pair", () => {
    const initials = def.stages.filter((s) => s.initial);
    expect(initials.map((s) => s.id)).toEqual(["intake"]);
    const terminals = def.stages.filter((s) => s.terminal).map((s) => s.id);
    expect(terminals).toEqual(["done", "aborted"]);
    for (const s of def.stages) {
      expect(Boolean(s.initial) && Boolean(s.terminal)).toBe(false);
    }
  });

  it("resolves every transition target to a declared stage", () => {
    const edges = def.stages.flatMap((s) => (s.transitions ?? []).map((t) => t.to));
    const globalEdges = (def.globalTransitions ?? []).map((t) => t.to);
    for (const to of [...edges, ...globalEdges]) {
      expect(stageById.has(to)).toBe(true);
    }
  });

  it("gives every non-terminal stage a work spec", () => {
    for (const s of def.stages) {
      if (s.terminal) continue;
      expect(s.work, `stage ${s.id}`).toBeDefined();
    }
  });

  it("routes the loop from intake and nowhere else", () => {
    expect(transition("intake", "fix").to).toBe("implementing");
    expect(transition("intake", "release").to).toBe("release-prep");
    expect(transition("intake", "close").to).toBe("done");
    for (const name of ["fix", "release", "close"]) {
      expect(gatesOfType("intake", name, "artifact-exists").length).toBe(1);
    }
  });

  it("keeps releases decoupled — the merge flow never routes into release-prep", () => {
    // The owner's 2026-09-10 call: not one-fix-per-release. The only edges
    // into release-prep are the owner-called intake routing and a failed
    // publish retry — merged work items simply land on done.
    const intoRelease = def.stages
      .filter((s) => (s.transitions ?? []).some((t) => t.to === "release-prep"))
      .map((s) => s.id);
    expect(intoRelease.sort()).toEqual(["intake", "publishing"].sort());
    expect(transition("merge", "merged").to).toBe("done");
  });

  it("bounds the rework loops with maxCycles on implementing and release-prep", () => {
    expect(stage("implementing").maxCycles).toBeGreaterThanOrEqual(2);
    expect(stage("release-prep").maxCycles).toBeGreaterThanOrEqual(2);
  });

  it("references only artifacts/evidence the source stage declares", () => {
    for (const s of def.stages) {
      const artifactNames = new Set((s.artifacts ?? []).map((a) => a.name));
      const evidenceNames = new Set((s.evidence ?? []).map((e) => e.name));
      for (const t of s.transitions ?? []) {
        for (const g of t.gates ?? []) {
          if (g.type === "artifact-exists" || g.type === "artifact-fresh" || g.type === "findings-clear") {
            expect(artifactNames.has(g.config.artifact), `${s.id}:${t.name}`).toBe(true);
          }
          if (g.type === "evidence-recorded") {
            expect(evidenceNames.has(g.config.name), `${s.id}:${t.name}`).toBe(true);
          }
        }
      }
    }
  });

  it("verifies locally before review and loops failures back", () => {
    expect(transition("verifying", "pass").to).toBe("review");
    expect(requireField("verifying", "pass", "gate-verify")).toEqual({ status: "succeeded" });
    expect(transition("verifying", "fail").to).toBe("implementing");
    expect(requireField("verifying", "fail", "gate-verify")).toEqual({ status: "failed" });
  });

  it("blocks the merge on a fresh adversarial review with no blocking findings", () => {
    const review = stage("review");
    expect(review.artifacts?.some((a) => a.name === "change-review" && a.kind === "findings")).toBe(true);
    const fresh = gatesOfType("review", "approve", "artifact-fresh");
    const clear = gatesOfType("review", "approve", "findings-clear");
    expect(fresh.map((g) => (g as any).config.artifact)).toEqual(["change-review"]);
    expect(clear.map((g) => (g as any).config.artifact)).toEqual(["change-review"]);
    expect(clear[0] && (clear[0] as any).config.blocking).toEqual(["critical", "high"]);
    expect(transition("review", "rework").to).toBe("implementing");
    expect(transition("review", "rework").gates ?? []).toEqual([]);
  });

  it("keeps the human approvals on merge, release, and abort", () => {
    expect(gateIds("merge", "merged", "human-approval")).toEqual(["merge-approval"]);
    expect(requireField("merge", "merged", "ci-run")).toEqual({ conclusion: "success" });
    expect(gateIds("release-prep", "approve", "human-approval")).toEqual(["release-approval"]);
    const abort = def.globalTransitions?.find((t) => t.name === "abort");
    expect(abort?.to).toBe("aborted");
    expect(abort?.gates?.map((g) => (g as any).config.id)).toEqual(["abort-confirmation"]);
  });

  it("gates tagging on all three release commands exiting 0", () => {
    const evidenceGates = gatesOfType("release-prep", "approve", "evidence-recorded");
    expect(evidenceGates.map((g) => (g as any).config.name).sort()).toEqual([
      "gate-drift",
      "gate-lint",
      "gate-qa",
    ]);
    for (const g of evidenceGates) {
      expect((g as any).config.requireField).toEqual({ exitCode: 0 });
    }
  });

  it("routes publishing only on a green release run", () => {
    expect(transition("publishing", "published").to).toBe("done");
    expect(requireField("publishing", "published", "release-run")).toEqual({
      conclusion: "success",
    });
    expect(transition("publishing", "failed").to).toBe("release-prep");
  });

  it("requires command + exitCode in every gate evidence schema", () => {
    const gateEvidence: Array<[string, string]> = [
      ["verifying", "gate-verify"],
      ["release-prep", "gate-qa"],
      ["release-prep", "gate-drift"],
      ["release-prep", "gate-lint"],
    ];
    for (const [stageId, name] of gateEvidence) {
      const decl = stage(stageId).evidence?.find((e) => e.name === name);
      expect(decl?.schema?.required, name).toContain("command");
      expect(decl?.schema?.required, name).toContain("exitCode");
    }
  });

  it("matches the record-gate.sh command inventory", () => {
    // scripts/swamp/record-gate.sh is invoked with these exact gate names in
    // the stage prompts; both sides must move together.
    const verifyPrompt = stage("verifying").work?.systemPrompt ?? "";
    expect(verifyPrompt).toContain("gate-verify");
    expect(verifyPrompt).toContain("bun run verify");
    const releasePrompt = stage("release-prep").work?.systemPrompt ?? "";
    for (const name of ["gate-qa", "gate-drift", "gate-lint"]) {
      expect(releasePrompt).toContain(name);
    }
    expect(releasePrompt).toContain("bun run qa:gate");
    expect(releasePrompt).toContain("bun run check:drift");
    expect(releasePrompt).toContain("bun run lint");
  });
});
