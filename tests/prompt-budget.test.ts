import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { currentTotals, ceilingHolds, type Ceilings } from "../scripts/prompt-budget/prompt-budget.ts";

describe("prompt-budget gate (#238)", () => {
  it("ceilings hold at current (+2% tolerance) and cover every mode × shape", () => {
    const current = currentTotals();
    const ceilings: Ceilings = JSON.parse(readFileSync(resolve(import.meta.dir, "../scripts/prompt-budget/ceilings.json"), "utf-8"));
    for (const [key, cur] of Object.entries(current)) {
      expect(ceilings[key], `missing ceiling for ${key}`).toBeTypeOf("number");
      expect(ceilingHolds(cur, ceilings[key]), `${key} ~${cur} breached ceiling ${ceilings[key]}`).toBe(true);
    }
    expect(Object.keys(current).length).toBe(30); // 5 modes × 6 shapes
  });

  it("a planted regression breaches: current above a lowered ceiling turns red", () => {
    // The #236 trim took the cobrowse fresh-action tail from 287 → 194 tok; a
    // ceiling pinned at the POST-trim total (1450) must fail if ~100 tok of
    // prompt weight creeps back (the drift-gate property, in miniature).
    expect(ceilingHolds(1450 + 100, 1450)).toBe(false);
    expect(ceilingHolds(1450, 1450)).toBe(true);
    // The +2% tolerance absorbs non-semantic churn only.
    expect(ceilingHolds(1450 + Math.ceil(1450 * 0.02), 1450)).toBe(true);
    expect(ceilingHolds(1450 + Math.ceil(1450 * 0.02) + 1, 1450)).toBe(false);
  });
});
