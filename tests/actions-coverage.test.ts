import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ACTION_TYPES } from "./schemas/actions";

// Context-only actions are consumed by the background stream loop and never
// reach a DOM executor; navigate/done are handled at the executeActions level
// in background.js, not inside its executeDomAction switch.
const CONTEXT_ONLY = new Set(["read_tab", "read_page", "get_dom", "get_form"]);
const BACKGROUND_ABOVE_SWITCH = new Set(["navigate", "done"]);
// fill_form executors landed with form-fill Task 3; the set stays for the
// next schema-first action type.
const PENDING = new Set<string>([]);

const DOM_TYPES = ACTION_TYPES.filter(
  (x) => !CONTEXT_ONLY.has(x) && !PENDING.has(x),
);

const CONTENT_SRC = readFileSync(
  resolve(import.meta.dir, "../extension/content.js"),
  "utf-8",
);
const BACKGROUND_SRC = readFileSync(
  resolve(import.meta.dir, "../extension/background.js"),
  "utf-8",
);

describe("action executor coverage", () => {
  it("content.js handles every DOM action type", () => {
    for (const t of DOM_TYPES) {
      expect(CONTENT_SRC).toContain(`case '${t}':`);
    }
  });
  it("background.js handles every action type (switch or above it)", () => {
    for (const t of DOM_TYPES) {
      if (BACKGROUND_ABOVE_SWITCH.has(t)) {
        expect(BACKGROUND_SRC).toContain(`action.type === '${t}'`);
      } else {
        expect(BACKGROUND_SRC).toContain(`case '${t}':`);
      }
    }
  });
});
