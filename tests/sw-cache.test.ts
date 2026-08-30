// Unit: lib/sw-cache.js — the MV3 service worker gets killed after ~30s idle,
// which made plain in-memory TTL caches fiction (#73). This factory keeps a
// memory fast-path but backs it with one chrome.storage.session key so the
// cache survives worker restarts. Pure: storage is injected.
import { describe, it, expect } from "bun:test";
import { createSessionCache } from "../extension/lib/sw-cache.js";

function fakeStorage() {
  const bag: Record<string, any> = {};
  return {
    bag,
    async get(key: string) { return { [key]: bag[key] }; },
    async set(obj: Record<string, any>) { Object.assign(bag, obj); },
  };
}

describe("createSessionCache", () => {
  it("fetches on first get and writes the entry to session storage", async () => {
    const storage = fakeStorage();
    let calls = 0;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000 });
    const v = await cache.get(() => { calls++; return Promise.resolve(["a"]); });
    expect(v).toEqual(["a"]);
    expect(calls).toBe(1);
    expect(storage.bag.k).toEqual({ value: ["a"], fetchedAt: expect.any(Number) });
  });

  it("serves the memory fast-path within TTL without refetching", async () => {
    const storage = fakeStorage();
    let calls = 0;
    let clock = 1000;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000, now: () => clock });
    await cache.get(() => { calls++; return Promise.resolve("v1"); });
    const v = await cache.get(() => { calls++; return Promise.resolve("v2"); });
    expect(v).toBe("v1");
    expect(calls).toBe(1);
  });

  it("hydrates from session storage in a FRESH instance (simulated SW restart)", async () => {
    const storage = fakeStorage();
    let calls = 0;
    const first = createSessionCache({ storage, key: "k", ttlMs: 60_000, now: () => 1000 });
    await first.get(() => Promise.resolve("survives"));
    // New worker: new module instance, same storage.
    const second = createSessionCache({ storage, key: "k", ttlMs: 60_000, now: () => 2000 });
    const v = await second.get(() => { calls++; return Promise.resolve("refetched"); });
    expect(v).toBe("survives");
    expect(calls).toBe(0);
  });

  it("expires entries past ttlMs and refetches", async () => {
    const storage = fakeStorage();
    let calls = 0;
    let clock = 1000;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000, now: () => clock });
    await cache.get(() => { calls++; return Promise.resolve("old"); });
    clock = 61_001;
    const v = await cache.get(() => { calls++; return Promise.resolve("new"); });
    expect(v).toBe("new");
    expect(calls).toBe(2);
  });

  it("force bypasses both memory and stored copies and overwrites them", async () => {
    const storage = fakeStorage();
    let calls = 0;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000, now: () => 1000 });
    await cache.get(() => Promise.resolve("stale"));
    const v = await cache.get(() => { calls++; return Promise.resolve("fresh"); }, true);
    expect(v).toBe("fresh");
    expect(calls).toBe(1);
    expect(storage.bag.k.value).toBe("fresh");
  });

  it("dedups concurrent fetches into one call", async () => {
    const storage = fakeStorage();
    let calls = 0;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000 });
    const [a, b] = await Promise.all([
      cache.get(() => { calls++; return new Promise((r) => setTimeout(() => r("x"), 5)); }),
      cache.get(() => { calls++; return new Promise((r) => setTimeout(() => r("y"), 5)); }),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe("x");
    expect(b).toBe("x");
  });

  it("treats null/undefined fetch results as a miss (never cached)", async () => {
    const storage = fakeStorage();
    let calls = 0;
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000 });
    await cache.get(() => { calls++; return Promise.resolve(null); });
    await cache.get(() => { calls++; return Promise.resolve(null); });
    expect(calls).toBe(2); // failed fetches are retried, not cached
    expect(storage.bag.k).toBeUndefined();
  });

  it("survives a throwing storage backend (fetch still wins)", async () => {
    const storage = { get: () => Promise.reject(new Error("no session")), set: () => Promise.reject(new Error("no session")) };
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000 });
    const v = await cache.get(() => Promise.resolve("ok"));
    expect(v).toBe("ok");
  });

  it("a thrown fetcher error propagates and clears the in-flight slot", async () => {
    const storage = fakeStorage();
    const cache = createSessionCache({ storage, key: "k", ttlMs: 60_000 });
    await expect(cache.get(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(cache.get(() => Promise.resolve("recovered"))).resolves.toBe("recovered");
  });
});
