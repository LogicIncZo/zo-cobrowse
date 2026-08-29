import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  buildCreateAutomationPrompt,
  buildGenerateModePrompt,
  buildListAutomationsPrompt,
  buildRunSkillPrompt,
  buildTestConnectionPrompt,
} from "../extension/lib/zo-prompts.js";
import { GenerateModeReplySchema } from "./schemas/zo-prompts.js";
import { presetToMode } from "../extension/lib/modes.js";
import { ModeSchema } from "./schemas/modes.js";

// Typed-schema conformance for the zo-prompts boundary. The builders return
// plain strings — validated here for their load-bearing content markers; the
// generate-mode REPLY is external data that background.generateMode
// JSON.parses, so the committed live-cache response must satisfy
// GenerateModeReplySchema and round-trip through presetToMode into a valid Mode.

const CACHE_PATH = resolve(import.meta.dir, "../scripts/prompt-evals/cache/generate-mode.json");

describe("zo-prompts — builder content contracts", () => {
  it("buildGenerateModePrompt demands strict JSON with the 7 Mode fields", () => {
    const p = buildGenerateModePrompt("a recipe extractor");
    expect(p).toContain("Return ONLY valid JSON");
    for (const field of ["name", "description", "icon", "systemPrompt", "instructions", "contextTier", "expectJson"]) {
      expect(p).toContain(field);
    }
    expect(typeof p).toBe("string");
    expect(p.length).toBeGreaterThan(200);
  });

  it("one-shot builders are non-empty strings with their protocol markers", () => {
    expect(buildRunSkillPrompt("my-skill", { url: "https://x", title: "X", visibleText: "t" })).toContain('my-skill');
    expect(buildCreateAutomationPrompt("do it", "FREQ=DAILY", null)).toContain("create_agent");
    expect(buildListAutomationsPrompt()).toContain("RRULE");
    expect(buildTestConnectionPrompt().toLowerCase()).toContain("zo_ok");
  });
});

describe("generate-mode reply — live cache satisfies the schema", () => {
  it("cached Zo output parses into GenerateModeReplySchema and resolves to a valid Mode", () => {
    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    const reply = JSON.parse(cache.output);

    const parsed = GenerateModeReplySchema.safeParse(reply);
    if (!parsed.success) {
      throw new Error(`generate-mode cache output failed schema:\n${parsed.error.message}`);
    }
    // The exact path background.generateMode takes with a valid reply.
    const mode = presetToMode(reply);
    const modeParsed = ModeSchema.safeParse(mode);
    if (!modeParsed.success) {
      throw new Error(`presetToMode(generate-mode reply) failed ModeSchema:\n${modeParsed.error.message}`);
    }
    expect(mode.builtin).toBe(false);
    expect(mode.id).toMatch(/^custom_/);
  });
});
