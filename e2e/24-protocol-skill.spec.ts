// E2E (#235 protocol skill): the bundled "cobrowse protocol" Zo skill
// installs into the mock workspace on the FIRST action turn (read_file miss →
// write_file → canary read-back), the tail slims to the skill pointer, and a
// stale/failed install falls back honestly. Asserts the wire: /mcp calls, the
// written content's injected version, and the /zo/ask prompt shape.

import { test, expect } from "@playwright/test";
import { E2E_BASE, openHarness, lastAskBody, clearRecordedRequests, waitForTurnComplete, sendQuery } from "./helpers/extension";

const SKILL_PATH = "/home/workspace/Skills/zo-cobrowse/SKILL.md";

async function recordedMcps(): Promise<any[]> {
  const res = await fetch(`${E2E_BASE}/__requests`);
  const list = await res.json();
  return list.filter((r: any) => r.url === "/mcp" && r.body?.method === "tools/call");
}

async function skillState(): Promise<{ content: string | null }> {
  const res = await fetch(`${E2E_BASE}/__skill`);
  return res.json();
}

async function resetSkill(): Promise<void> {
  await fetch(`${E2E_BASE}/__skill`, { method: "DELETE" });
  await clearRecordedRequests();
}

const ACTION_QUERY = "Click the first link on the page";

test.describe("protocol-skill install (#235)", () => {
  test("fresh workspace: first action turn installs the skill and slims the tail", async () => {
    const h = await openHarness({ freshProfile: true });
    try {
      await resetSkill();
      await sendQuery(h.panel, ACTION_QUERY);
      await waitForTurnComplete(h.panel);

      // Install loop ran exactly: read (miss) → write → canary read.
      const calls = (await recordedMcps()).map((r) => r.body.params?.name);
      const toolCalls = calls.filter((n) => n === "read_file" || n === "write_file");
      expect(toolCalls).toEqual(["read_file", "write_file", "read_file"]);

      // The write targeted the workspace path and carried the manifest version.
      const manifestVersion = await h.serviceWorker.evaluate(() => (chrome.runtime.getManifest() as any).version);
      const write = (await recordedMcps()).find((r) => r.body.params?.name === "write_file");
      expect(write.body.params.arguments.target_file).toBe(SKILL_PATH);
      expect(write.body.params.arguments.content).toContain(`version: "${manifestVersion}"`);
      // The stored copy IS the written content.
      expect((await skillState()).content).toContain(`version: "${manifestVersion}"`);

      // The turn's prompt is the SLIM tail: skill pointer + envelope + safety
      // rules; the grammar moved server-side.
      const ask = await lastAskBody();
      expect(ask.input).toContain("cobrowse-protocol-skill");
      expect(ask.input).toContain("Skills/zo-cobrowse");
      expect(ask.input).toContain('Respond with JSON {"actions":[...]}');
      expect(ask.input).toContain("password/card/CVV");
      expect(ask.input).not.toContain("click{selector}");
      expect(ask.input).not.toContain("read_file{path}");
    } finally {
      await h.context.close();
    }
  });

  test("stale installed copy is rewritten with the current version", async () => {
    const h = await openHarness({ freshProfile: true });
    try {
      await resetSkill();
      // Seed a STALE copy (ancient version) as the already-installed skill.
      await fetch(`${E2E_BASE}/__skill`, {
        method: "PUT",
        body: '---\nname: zo-cobrowse\ndescription: stale\nmetadata:\n  version: "0.0.1"\n---\n\nold protocol\n',
      });
      await clearRecordedRequests();
      await sendQuery(h.panel, ACTION_QUERY);
      await waitForTurnComplete(h.panel);

      // read (hit, stale) → write (rewrite) → canary read.
      const toolCalls = (await recordedMcps()).map((r) => r.body.params?.name).filter((n) => n === "read_file" || n === "write_file");
      expect(toolCalls).toEqual(["read_file", "write_file", "read_file"]);

      const manifestVersion = await h.serviceWorker.evaluate(() => (chrome.runtime.getManifest() as any).version);
      expect((await skillState()).content).toContain(`version: "${manifestVersion}"`);
      expect((await skillState()).content).not.toContain('version: "0.0.1"');
      const ask = await lastAskBody();
      expect(ask.input).toContain("cobrowse-protocol-skill");
    } finally {
      await h.context.close();
    }
  });

  test("write_file failure falls back to the one-shot ask write — tail still slims on verify", async () => {
    const h = await openHarness({ freshProfile: true });
    try {
      await resetSkill();
      await fetch(`${E2E_BASE}/__skill?mode=writefail`, { method: "PUT" });
      await clearRecordedRequests();
      await sendQuery(h.panel, ACTION_QUERY);
      await waitForTurnComplete(h.panel);

      // The fallback went through the one-shot agent-write prompt…
      const res = await fetch(`${E2E_BASE}/__requests`);
      const asks = (await res.json()).filter((r: any) => r.url === "/zo/ask");
      const fallback = asks.find((r: any) => String(r.body?.input || "").includes("---CONTENT START---"));
      expect(fallback).toBeTruthy();
      expect(fallback.body.input).toContain(SKILL_PATH);
      // …and the workspace copy it produced verified → the turn slimmed.
      const manifestVersion = await h.serviceWorker.evaluate(() => (chrome.runtime.getManifest() as any).version);
      expect((await skillState()).content).toContain(`version: "${manifestVersion}"`);
      const ask = await lastAskBody();
      expect(ask.input).toContain("cobrowse-protocol-skill");
      expect(ask.input).not.toContain("click{selector}");
    } finally {
      await h.context.close();
    }
  });
});
