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
// #412 multi-file install: read (miss/stale) → write SKILL.md → write the two
// references → canary read of SKILL.md.
const INSTALL_CALLS = ["read_file", "write_file", "write_file", "write_file", "read_file"];

/**
 * The #412 onInstalled sync and the lazy first-turn check race the harness's
 * token seeding: whichever point the token first becomes visible performs the
 * install. Poll for a startup install (the workspace copy carrying the
 * current manifest version); the specs then assert the recorded window
 * conditionally — startup-installed ⇒ the turn adds zero calls, otherwise the
 * turn-time lazy install ran the full sequence.
 */
async function waitForStartupInstall(version: string): Promise<boolean> {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const c = (await skillState()).content;
    if (c && c.includes(`version: "${version}"`)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test.describe("protocol-skill install (#235)", () => {
  test("fresh workspace: first action turn installs the skill and slims the tail", async () => {
    await resetSkill();
    const h = await openHarness({ freshProfile: true });
    try {
      const manifestVersion = await h.serviceWorker.evaluate(() => (chrome.runtime.getManifest() as any).version);
      const startupInstalled = await waitForStartupInstall(manifestVersion);
      await clearRecordedRequests();
      await sendQuery(h.panel, ACTION_QUERY);
      await waitForTurnComplete(h.panel);

      // The install ran at WHICHEVER point the token first became visible:
      // the #412 startup sync (zero in-window calls) or the lazy turn-time
      // check (the full multi-file sequence).
      const calls = (await recordedMcps()).map((r) => r.body.params?.name);
      const toolCalls = calls.filter((n) => n === "read_file" || n === "write_file");
      if (startupInstalled) {
        expect(toolCalls).toEqual([]);
      } else {
        expect(toolCalls).toEqual(INSTALL_CALLS);
        // The SKILL.md write targeted the workspace path and carried the
        // manifest version; the reference writes landed under references/.
        const writes = (await recordedMcps()).filter((r) => r.body.params?.name === "write_file");
        expect(writes[0].body.params.arguments.target_file).toBe(SKILL_PATH);
        expect(writes[0].body.params.arguments.content).toContain(`version: "${manifestVersion}"`);
        for (const w of writes.slice(1)) {
          expect(w.body.params.arguments.target_file).toMatch(/^\/home\/workspace\/Skills\/zo-cobrowse\/references\/[\w-]+\.md$/);
        }
      }
      // The stored copy carries the manifest version either way.
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
    await resetSkill();
    await fetch(`${E2E_BASE}/__skill`, {
      method: "PUT",
      body: '---\nname: zo-cobrowse\ndescription: stale\nmetadata:\n  version: "0.0.1"\n---\n\nold protocol\n',
    });
    const h = await openHarness({ freshProfile: true });
    try {
      const manifestVersion = await h.serviceWorker.evaluate(() => (chrome.runtime.getManifest() as any).version);
      // The stale rewrite happens at WHICHEVER point the token first became
      // visible: the #412 startup sync (zero in-window calls) or the lazy
      // turn-time check (the full multi-file sequence).
      const startupInstalled = await waitForStartupInstall(manifestVersion);
      await clearRecordedRequests();
      await sendQuery(h.panel, ACTION_QUERY);
      await waitForTurnComplete(h.panel);

      const toolCalls = (await recordedMcps()).map((r) => r.body.params?.name).filter((n) => n === "read_file" || n === "write_file");
      if (startupInstalled) {
        expect(toolCalls).toEqual([]);
      } else {
        expect(toolCalls).toEqual(INSTALL_CALLS);
      }
      // Either way the stale copy is gone and the current version is in.
      expect((await skillState()).content).toContain(`version: "${manifestVersion}"`);
      expect((await skillState()).content).not.toContain('version: "0.0.1"');
      const ask = await lastAskBody();
      expect(ask.input).toContain("cobrowse-protocol-skill");
    } finally {
      await h.context.close();
    }
  });

  test("write_file failure falls back to the one-shot ask write — tail still slims on verify", async () => {
    await resetSkill();
    await fetch(`${E2E_BASE}/__skill?mode=writefail`, { method: "PUT" });
    const h = await openHarness({ freshProfile: true });
    try {
      const manifestVersion = await h.serviceWorker.evaluate(() => (chrome.runtime.getManifest() as any).version);
      await waitForStartupInstall(manifestVersion);
      // NO clear here: when the startup sync won the token race, ITS fallback
      // write is the recorded one; the last CONTENT START ask is ours either way.
      await sendQuery(h.panel, ACTION_QUERY);
      await waitForTurnComplete(h.panel);

      // The fallback went through the one-shot agent-write prompt (the LAST
      // such ask — startup-sync or turn-time, whichever performed the write)…
      const res = await fetch(`${E2E_BASE}/__requests`);
      const asks = (await res.json()).filter((r: any) => r.url === "/zo/ask");
      const fallback = asks.filter((r: any) => String(r.body?.input || "").includes("---CONTENT START---")).pop();
      expect(fallback).toBeTruthy();
      expect(fallback.body.input).toContain(SKILL_PATH);
      // …and the workspace copy it produced verified → the turn slimmed.
      expect((await skillState()).content).toContain(`version: "${manifestVersion}"`);
      const ask = await lastAskBody();
      expect(ask.input).toContain("cobrowse-protocol-skill");
      expect(ask.input).not.toContain("click{selector}");
    } finally {
      await h.context.close();
    }
  });
});
