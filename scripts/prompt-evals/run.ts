#!/usr/bin/env bun
/**
 * Prompt evals — score EVERY prompt the extension sends against deterministic
 * checkers, so prompt regressions and tuning are measurable.
 *
 *   bun run evals            — offline: grade the committed cache (CI-safe)
 *   bun run evals:live       — live: fetch missing/stale responses with a real
 *                              token (bun --env-file=.env), refresh the cache
 *   ... --force              — refetch every live case
 *   ... --only <substr>      — run a subset of cases by id
 *
 * Cache: scripts/prompt-evals/cache/<id>.json keyed by sha256(prompt) — a
 * prompt edit invalidates its entry, so the offline run goes red until someone
 * re-runs live and commits the refreshed response. Side-effectful prompts
 * (create-automation, run-skill) are graded statically and never sent live.
 *
 * Exit code 0 only when every case passes.
 */

import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CASES, parseForKind, type EvalCase } from "./cases.ts";
import type { CheckResult, EvalOutput } from "./checkers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, "cache");

const TOKEN = process.env.ZO_API_KEY || process.env.ZO_ACCESS_TOKEN || "";

/**
 * Endpoint pinning (SSRF guard): evals always talk to the canonical Zo API —
 * https + host allowlist, never an env-chosen or private-network URL.
 */
function evalApiUrl(): string {
  const raw = process.env.ZO_API_URL || "https://api.zo.computer/zo/ask";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("ZO_API_URL is not a valid URL");
  }
  if (u.protocol !== "https:" || u.hostname !== "api.zo.computer") {
    throw new Error(
      "ZO_API_URL for evals must be https://api.zo.computer/… (got " + u.protocol + "//" + u.hostname + ")",
    );
  }
  return "https://api.zo.computer" + u.pathname;
}

const ZO_API_URL = evalApiUrl();

const LIVE = process.argv.includes("--live");
const FORCE = process.argv.includes("--force");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx !== -1 ? process.argv[onlyIdx + 1] || "" : "";

interface CacheEntry {
  id: string;
  promptHash: string;
  fetchedAt: string;
  output: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function cachePath(id: string): string {
  return resolve(CACHE_DIR, id + ".json");
}

function loadCache(id: string): CacheEntry | null {
  const p = cachePath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CacheEntry;
  } catch {
    return null;
  }
}

async function fetchLive(input: string): Promise<string> {
  const resp = await fetch(ZO_API_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      input: input,
      // Optional model pin (EVALS_MODEL): when Zo's server-default model is
      // disabled/rotated upstream, evals pin a live-catalog model so the
      // refresh can run. Cache stays keyed by prompt hash; checkers grade
      // structure, not model voice.
      ...(process.env.EVALS_MODEL ? { model_name: process.env.EVALS_MODEL } : {}),
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error("HTTP " + resp.status + " — " + body.slice(0, 160));
  }
  const data = await resp.json();
  return String(data.output ?? "");
}

interface Row {
  id: string;
  status: "PASS" | "FAIL" | "SKIP" | "STALE";
  source: "live" | "cache" | "static" | "-";
  failed: CheckResult[];
  note?: string;
}

async function main() {
  const cases = CASES.filter((c) => !ONLY || c.id.includes(ONLY));
  mkdirSync(CACHE_DIR, { recursive: true });

  const rows: Row[] = [];
  let liveCalls = 0;

  for (const c of cases) {
    const input = c.build();
    const hash = sha256(input);

    // Static-only case (side-effectful prompt): grade the prompt, no network.
    if (!c.live) {
      const out: EvalOutput = { input: input, raw: "", parsed: undefined, text: "" };
      const failed = c.checks.map((chk) => chk(out)).filter((r) => !r.pass);
      rows.push({ id: c.id, status: failed.length ? "FAIL" : "PASS", source: "static", failed: failed });
      continue;
    }

    // Live case: get an output from cache or the API.
    let entry = loadCache(c.id);
    let stale = !entry || entry.promptHash !== hash;
    let source: "live" | "cache" = "cache";

    if (LIVE) {
      if (!TOKEN) {
        rows.push({ id: c.id, status: "SKIP", source: "-", failed: [], note: "no ZO_API_KEY in env" });
        continue;
      }
      if (!entry || stale || FORCE) {
        try {
          const output = await fetchLive(input);
          liveCalls++;
          entry = { id: c.id, promptHash: hash, fetchedAt: new Date().toISOString(), output: output };
          writeFileSync(cachePath(c.id), JSON.stringify(entry, null, 2) + "\n");
          source = "live";
          stale = false;
          await new Promise((r) => setTimeout(r, 400)); // be gentle with the API
        } catch (err) {
          rows.push({ id: c.id, status: "FAIL", source: "live", failed: [], note: "API error: " + (err as Error).message });
          continue;
        }
      }
    } else if (stale) {
      rows.push({
        id: c.id,
        status: "STALE",
        source: "-",
        failed: [],
        note: entry ? "prompt changed since cache — re-run evals:live" : "no cache — re-run evals:live",
      });
      continue;
    }

    const { parsed, text } = parseForKind(c.kind, entry!.output);
    const out: EvalOutput = { input: input, raw: entry!.output, parsed: parsed, text: text };
    const failed = c.checks.map((chk) => chk(out)).filter((r) => !r.pass);
    rows.push({ id: c.id, status: failed.length ? "FAIL" : "PASS", source: source, failed: failed });
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
  const width = Math.max(...rows.map((r) => r.id.length)) + 2;
  console.log("");
  console.log("Prompt evals — " + cases.length + " cases (" + (LIVE ? "LIVE" : "offline cache") + ")");
  console.log("─".repeat(width + 46));
  for (const r of rows) {
    const mark = r.status === "PASS" ? "✓" : r.status === "SKIP" ? "·" : "✗";
    let line = mark + " " + pad(r.id, width) + pad(r.status, 7) + pad(r.source, 7);
    if (r.status === "FAIL") {
      console.log(line);
      for (const f of r.failed) {
        console.log("      ✗ " + f.name + (f.detail ? " — " + f.detail : ""));
      }
      if (r.note) console.log("      " + r.note);
    } else {
      console.log(line + (r.note ? "— " + r.note : ""));
    }
  }
  console.log("─".repeat(width + 46));
  const pass = rows.filter((r) => r.status === "PASS").length;
  const failCount = rows.filter((r) => r.status === "FAIL" || r.status === "STALE").length;
  console.log(pass + "/" + rows.length + " pass" + (liveCalls ? " · " + liveCalls + " live call(s)" : "") + (failCount ? " · " + failCount + " failing" : ""));
  if (failCount) {
    if (!LIVE) console.log("\nOffline run — some failures may just need a refresh: bun run evals:live");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
