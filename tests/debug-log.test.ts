// Unit: lib/debug-log.js — the #67 diagnostics ring buffer. Privacy contract
// is the load-bearing part: metadata only (kinds/labels/durations/scalar
// extras, strings truncated), never page text, prompts, or tokens.
import { describe, it, expect } from "bun:test";
import { createDebugLog } from "../extension/lib/debug-log.js";

describe("createDebugLog", () => {
  it("records nothing while disabled; setEnabled(true) starts recording", () => {
    const log = createDebugLog();
    log.push("msg", "ASK_ZO");
    expect(log.entries().entries).toHaveLength(0);
    log.setEnabled(true);
    log.push("msg", "ASK_ZO");
    expect(log.entries().entries).toHaveLength(1);
  });

  it("setEnabled(false) clears the buffer (no stale diagnostics linger)", () => {
    const log = createDebugLog();
    log.setEnabled(true);
    log.push("msg", "ASK_ZO");
    log.setEnabled(false);
    expect(log.entries().entries).toHaveLength(0);
  });

  it("is a ring: past max, oldest entries drop and the drop count is reported", () => {
    let t = 1000;
    const log = createDebugLog({ max: 3, now: () => t++ });
    log.setEnabled(true);
    for (let i = 0; i < 5; i++) log.push("tick", `t${i}`);
    const { entries, dropped } = log.entries();
    expect(entries.map((e: any) => e.label)).toEqual(["t2", "t3", "t4"]);
    expect(dropped).toBe(2);
  });

  it("records durations rounded to 2 decimals", () => {
    const log = createDebugLog();
    log.setEnabled(true);
    log.push("capture", "getActiveTabContext", 12.3456);
    expect(log.entries().entries[0].durMs).toBe(12.35);
  });

  it("PRIVACY: extras keep only finite scalars; strings truncate at 120 chars", () => {
    const log = createDebugLog();
    log.setEnabled(true);
    const longSecret = "x".repeat(500) + " token=supersecret";
    log.push("msg", "turn", 5, {
      model: "zo:zai/glm-5.3-flash",
      tier: 0,
      shot: false,
      pageText: longSecret,          // string → truncated (defense in depth)
      prompt: { nested: "object" },  // object → dropped
      tags: ["a"],                   // array → dropped
      nan: NaN,                      // non-finite → dropped
      token: undefined,              // undefined → dropped
    });
    const e = log.entries().entries[0];
    expect(e.extra.model).toBe("zo:zai/glm-5.3-flash");
    expect(e.extra.tier).toBe(0);
    expect(e.extra.pageText).toHaveLength(120);
    expect(e.extra.prompt).toBeUndefined();
    expect(e.extra.tags).toBeUndefined();
    expect(e.extra.nan).toBeUndefined();
    expect(e.extra.token).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain("supersecret");
  });

  it("labels and kinds truncate (no free-text smuggling)", () => {
    const log = createDebugLog();
    log.setEnabled(true);
    log.push("k".repeat(100), "l".repeat(300));
    const e = log.entries().entries[0];
    expect(e.kind).toHaveLength(40);
    expect(e.label).toHaveLength(120);
  });

  it("clear() empties the buffer and the drop counter", () => {
    const log = createDebugLog({ max: 2 });
    log.setEnabled(true);
    log.push("a", "1");
    log.push("a", "2");
    log.push("a", "3");
    log.clear();
    const { entries, dropped } = log.entries();
    expect(entries).toHaveLength(0);
    expect(dropped).toBe(0);
  });

  // ---- Lane B 2-0: trace correlation ----

  it("setTrace stamps subsequent entries; null clears the context", () => {
    const log = createDebugLog();
    log.setEnabled(true);
    log.push("msg", "untagged");
    log.setTrace("turn-7:chat-3");
    log.push("stream", "askZoStream:done", 1234);
    log.setTrace(null);
    log.push("msg", "after");
    const { entries } = log.entries();
    expect(entries[0].traceId).toBeUndefined();
    expect(entries[1].traceId).toBe("turn-7:chat-3");
    expect(entries[2].traceId).toBeUndefined();
  });

  it("trace ids are metadata: capped at 64 chars", () => {
    const log = createDebugLog();
    log.setEnabled(true);
    log.setTrace("t".repeat(200));
    log.push("msg", "x");
    expect(log.entries().entries[0].traceId).toHaveLength(64);
  });

  it("exports are versioned (version: 2) so analysis tools can rely on the shape", () => {
    const log = createDebugLog();
    log.setEnabled(true);
    log.push("msg", "x");
    expect(log.entries().version).toBe(2);
  });
});
