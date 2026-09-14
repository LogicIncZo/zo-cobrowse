// Integration: the no-token guard branches of the utility handlers. This is
// a SECOND background.js instance (unique ?file= cache-buster) whose bus
// deliberately seeds NO zoAccessToken — handlers-flow.test.ts is the
// token-bearing instance. The fetch mock refuses every request so a missing
// guard can never leak a real network call; the `requests.length` assertion
// pins "no fetch attempted".

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createFakeChrome } from "../helpers/chrome-mock.ts";
import { ZoFetchMock, jsonResponse } from "../helpers/zo-fetch-mock.ts";

const bus = createFakeChrome();
const fm = new ZoFetchMock();

const flush = () => new Promise((r) => setTimeout(r, 25));

beforeAll(async () => {
  // NOTE: no zoAccessToken seeded.
  fm.install();
  fm.handle(() => jsonResponse({ output: "should never be reached" }));
  (globalThis as any).chrome = bus;
  await import("../../extension/background.js?file=no-token-flow");
  await flush();
});

afterAll(() => {
  fm.restore();
});

describe("no-token guard branches", () => {
  it("SAVE_PAGE refuses without a token", async () => {
    const resp = await bus.runtime.sendMessage({
      type: "SAVE_PAGE",
      pageContext: { title: "T", url: "https://x.dev/", visibleText: "" },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("token");
  });

  it("DUCKDB_QUERY refuses without a token", async () => {
    const resp = await bus.runtime.sendMessage({ type: "DUCKDB_QUERY", naturalQuery: "q" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("token");
  });

  it("LIST_MODELS refuses without a token", async () => {
    expect(await bus.runtime.sendMessage({ type: "LIST_MODELS" })).toEqual({ error: "No token" });
  });

  it("LIST_PERSONAS refuses without a token", async () => {
    expect(await bus.runtime.sendMessage({ type: "LIST_PERSONAS" })).toEqual({ error: "No token" });
  });

  it("GENERATE_MODE refuses without a token", async () => {
    expect(await bus.runtime.sendMessage({ type: "GENERATE_MODE", description: "d" })).toEqual({ error: "No token" });
  });

  it("TEST_CONNECTION reports a configuration failure without a token", async () => {
    const resp = await bus.runtime.sendMessage({ type: "TEST_CONNECTION" });
    expect(resp.success).toBe(false);
    expect(resp.error).toContain("No access token");
  });

  it("no handler fetch was attempted across all guards", () => {
    expect(fm.requests).toHaveLength(0);
  });
});
