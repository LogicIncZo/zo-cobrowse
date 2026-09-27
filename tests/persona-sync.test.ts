import { describe, it, expect } from "bun:test";
import {
  PERSONA_STORAGE_KEY,
  PERSONA_STATE_KEY,
  PERSONA_NAME_PREFIX,
  promptHash,
  personaNameFor,
  parsePersonaId,
  decidePersona,
  planPersonaSweep,
} from "../extension/lib/persona-sync.js";
import { BUILTIN_MODES } from "../extension/lib/modes.js";
import { PersonaMapSchema, PersonaStateSchema } from "./schemas/persona.ts";

const CO = BUILTIN_MODES.cobrowse;
const entryFor = (mode: any, personaId = "11111111-2222-3333-4444-555555555555") => ({
  personaId,
  prompt: mode.systemPrompt,
  name: personaNameFor(mode.id, mode.systemPrompt),
});

describe("persona-sync constants + naming (#415)", () => {
  it("storage keys follow the cobrowse_ convention", () => {
    expect(PERSONA_STORAGE_KEY).toBe("cobrowse_personas");
    expect(PERSONA_STATE_KEY).toBe("cobrowse_personas_state");
    expect(PERSONA_NAME_PREFIX).toBe("zo-cobrowse:");
  });

  it("the name embeds a prompt hash — same prompt ⇒ same name, drift ⇒ different name", () => {
    const a = personaNameFor("cobrowse", CO.systemPrompt);
    expect(a).toBe(`zo-cobrowse: cobrowse · ${promptHash(CO.systemPrompt)}`);
    expect(personaNameFor("cobrowse", CO.systemPrompt + " ")).not.toBe(a);
    expect(promptHash("")).toHaveLength(7);
  });

  it("parsePersonaId reads the python-repr create response (not JSON)", () => {
    const created = "id='c5aa45e2-e041-4262-a437-d0303aa70d13' name='x' prompt=\"y\"";
    expect(parsePersonaId(created)).toBe("c5aa45e2-e041-4262-a437-d0303aa70d13");
    expect(parsePersonaId("no id here")).toBe("");
    expect(parsePersonaId(null)).toBe("");
  });
});

describe("decidePersona — fail-closed per-turn decision", () => {
  it("uses the persona on a builtin Mode with a byte-equal stored prompt", () => {
    const stored = { cobrowse: entryFor(CO) };
    const d = decidePersona(CO, stored);
    expect(d).toEqual({ kind: "use", personaId: "11111111-2222-3333-4444-555555555555" });
  });

  it("skips custom Modes, non-builtin shapes, and missing entries", () => {
    expect(decidePersona({ ...CO, builtin: false }, { cobrowse: entryFor(CO) }).kind).toBe("skip");
    expect(decidePersona(CO, {}).kind).toBe("sync");
    expect(decidePersona(CO, null as any).kind).toBe("sync");
    expect(decidePersona(null as any, {}).kind).toBe("skip");
  });

  it("flags stale (drifted) prompts for re-creation — never uses them", () => {
    const drifted = { ...entryFor(CO), prompt: CO.systemPrompt + " (old framing)" };
    const d = decidePersona(CO, { cobrowse: drifted });
    expect(d.kind).toBe("sync");
    expect((d as any).stalePersonaId).toBe(drifted.personaId);
  });
});

describe("planPersonaSweep — prefix-scoped orphan cleanup", () => {
  const mine = (id: string, name: string) => ({ id, name });
  it("deletes only our prefix and only non-targets", () => {
    const t1 = personaNameFor("cobrowse", CO.systemPrompt);
    const listed = [
      mine("a", t1), // current target — keep
      mine("b", "zo-cobrowse: cobrowse · oldhash"), // ours, stale — sweep
      mine("c", "user's own persona"), // not ours — never touched
      mine("d", "zo-cobrowse: lean · xyz"), // ours, not a target — sweep
      null, // tolerate junk
    ];
    expect(planPersonaSweep(listed as any, [t1])).toEqual(["b", "d"]);
  });
  it("tolerates a missing/broken listing", () => {
    expect(planPersonaSweep(null as any, [])).toEqual([]);
    expect(planPersonaSweep("garbage" as any, [])).toEqual([]);
  });
});

describe("schema contract", () => {
  it("the stored persona map validates", () => {
    const map = Object.fromEntries(
      Object.values(BUILTIN_MODES).map((m: any) => [m.id, entryFor(m)]),
    );
    expect(PersonaMapSchema.safeParse(map).success).toBe(true);
    expect(PersonaMapSchema.safeParse({ cobrowse: { personaId: "" } }).success).toBe(false);
  });

  it("the session guard state validates", () => {
    expect(PersonaStateSchema.safeParse({ checkedVersion: "0.3.7.0" }).success).toBe(true);
    expect(PersonaStateSchema.safeParse({}).success).toBe(false);
  });
});
