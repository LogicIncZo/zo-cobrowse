import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  STORAGE,
  DEFAULTS,
  loadConfig,
  saveConfig,
} from "../extension/lib/config.js";

/**
 * Behavioral tests for extension/lib/config.js.
 *
 * Previously this module was only string-matched (settings-persistence.test.ts
 * greps background.js/options.js for `chrome.storage.sync.get`). These tests
 * execute the REAL loadConfig/saveConfig against an in-memory chrome mock,
 * exercising:
 *   - DEFAULTS merge (sync values override defaults; unknown sync keys ignored)
 *   - sensitive-key routing (token + endpoint read from storage.local)
 *   - saveConfig splits sensitive vs sync across areas
 *   - round-trip: save → load returns what was saved
 *
 * watchConfig() is also exercised: storage.onChanged fires → handler is called
 * with a freshly-loaded config.
 *
 * No chrome.* is mocked at import time; the module imports cleanly because it
 * only touches chrome.* inside its function bodies.
 */

// --- In-memory chrome mock (callback + promise style, matches chrome.storage) ---
function createStorageArea() {
  let store: Record<string, any> = {};
  const area: any = {
    get(keys: any, cb?: Function) {
      if (typeof keys === "function") { cb = keys; keys = null; }
      let result: Record<string, any> = {};
      if (keys === null || keys === undefined) {
        result = { ...store };
      } else if (typeof keys === "string") {
        result = { [keys]: store[keys] };
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (k in store) result[k] = store[k];
      } else {
        for (const k of Object.keys(keys)) result[k] = k in store ? store[k] : keys[k];
      }
      if (cb) cb(result);
      return Promise.resolve(result);
    },
    set(items: Record<string, any>, cb?: Function) {
      Object.assign(store, items);
      if (cb) cb();
      return Promise.resolve();
    },
    remove(keys: string | string[], cb?: Function) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete store[k];
      if (cb) cb();
      return Promise.resolve();
    },
    clear(cb?: Function) {
      store = {};
      if (cb) cb();
      return Promise.resolve();
    },
  };
  return area;
}

let chromeMock: any;

beforeEach(() => {
  const onChangedListeners: Function[] = [];
  const onChangedApi = {
    addListener: (fn: Function) => onChangedListeners.push(fn),
    removeListener: (fn: Function) => {
      const i = onChangedListeners.indexOf(fn);
      if (i >= 0) onChangedListeners.splice(i, 1);
    },
    // Test helper: fire the change event as chrome.storage.onChanged does.
    __fire(changes: Record<string, { newValue?: any; oldValue?: any }>, area: string) {
      onChangedListeners.slice().forEach((fn) => fn(changes, area));
    },
  };
  chromeMock = {
    storage: {
      sync: createStorageArea(),
      local: createStorageArea(),
      onChanged: onChangedApi,
    },
  };
  (globalThis as any).chrome = chromeMock;
});

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe("DEFAULTS + STORAGE — shape invariants", () => {
  it("STORAGE maps to stable, non-empty string keys", () => {
    for (const [logical, key] of Object.entries(STORAGE)) {
      expect(typeof key).toBe("string");
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it("every STORAGE key that represents a configurable value is in DEFAULTS", () => {
    // STORAGE carries several keys that are intentionally NOT in DEFAULTS:
    //   - TOKEN: a secret, never defaulted into config snapshots.
    //   - LITE/FULL_PERSONA_ID + PERSONA_MODE: legacy persona-routing keys
    //     (config.js: "read once for migration, then ignored").
    //   - CUSTOM_MODES: managed as its own object, not a scalar default.
    //   - MODE_OVERRIDES: a per-built-in-id sparse catalog, like CUSTOM_MODES.
    const nonDefaulted = new Set([
      "TOKEN", "LITE_PERSONA_ID", "FULL_PERSONA_ID", "PERSONA_MODE", "CUSTOM_MODES",
      "MODE_OVERRIDES",
    ]);
    for (const [logical, key] of Object.entries(STORAGE)) {
      if (nonDefaulted.has(logical)) continue;
      expect(key in DEFAULTS, `${logical} (${key}) missing from DEFAULTS`).toBe(true);
    }
  });

  it("migration-only + secret keys live in STORAGE but not DEFAULTS", () => {
    // These exist as storage keys but intentionally carry no default value.
    expect(STORAGE.TOKEN in DEFAULTS).toBe(false);
    expect(STORAGE.LITE_PERSONA_ID in DEFAULTS).toBe(false);
    expect(STORAGE.FULL_PERSONA_ID in DEFAULTS).toBe(false);
    expect(STORAGE.PERSONA_MODE in DEFAULTS).toBe(false);
    expect(STORAGE.CUSTOM_MODES in DEFAULTS).toBe(false);
    expect(STORAGE.MODE_OVERRIDES in DEFAULTS).toBe(false);
  });

  it("the sensitive token key is NOT defaulted (never persisted as a default)", () => {
    expect(STORAGE.TOKEN in DEFAULTS).toBe(false);
  });

  it("DEFAULTS points the API URL at the canonical Zo /zo/ask endpoint", () => {
    expect(DEFAULTS[STORAGE.API_URL]).toBe("https://api.zo.computer/zo/ask");
  });

  it("the default active mode is cobrowse", () => {
    expect(DEFAULTS[STORAGE.ACTIVE_MODE]).toBe("cobrowse");
  });
});

describe("loadConfig — merge semantics", () => {
  it("returns DEFAULTS unchanged when both stores are empty", async () => {
    const config = await loadConfig();
    expect(config[STORAGE.ACTIVE_MODE]).toBe(DEFAULTS[STORAGE.ACTIVE_MODE]);
    expect(config[STORAGE.MODEL]).toBe(DEFAULTS[STORAGE.MODEL]);
    expect(config[STORAGE.API_URL]).toBe(DEFAULTS[STORAGE.API_URL]);
  });

  it("sync values override DEFAULTS for known keys", async () => {
    await chromeMock.storage.sync.set({
      [STORAGE.MODEL]: "zo-1.1-pro",
      [STORAGE.ACTIVE_MODE]: "lean",
    });
    const config = await loadConfig();
    expect(config[STORAGE.MODEL]).toBe("zo-1.1-pro");
    expect(config[STORAGE.ACTIVE_MODE]).toBe("lean");
  });

  it("sensitive values (token + endpoint) are read from storage.local, not sync", async () => {
    await chromeMock.storage.local.set({
      [STORAGE.TOKEN]: "secret-abc",
      [STORAGE.SPACE_ENDPOINT]: "https://my.zo.space",
    });
    // Even if sync somehow carries a token, local wins (loadConfig reads local).
    await chromeMock.storage.sync.set({ [STORAGE.TOKEN]: "should-be-ignored" });
    const config = await loadConfig();
    expect(config[STORAGE.TOKEN]).toBe("secret-abc");
    expect(config[STORAGE.SPACE_ENDPOINT]).toBe("https://my.zo.space");
  });

  it("undefined sync values do not shadow DEFAULTS", async () => {
    // An explicitly-undefined sync value must not clobber a default.
    await chromeMock.storage.sync.set({ [STORAGE.MODEL]: undefined });
    const config = await loadConfig();
    expect(config[STORAGE.MODEL]).toBe(DEFAULTS[STORAGE.MODEL]);
  });

  it("unknown sync keys are ignored (not merged into config)", async () => {
    await chromeMock.storage.sync.set({ randomJunkKey: "x", anotherStranger: 42 });
    const config = await loadConfig() as Record<string, any>;
    expect(config.randomJunkKey).toBeUndefined();
    expect(config.anotherStranger).toBeUndefined();
  });

  it("local-only non-sensitive keys are ignored too", async () => {
    // Only TOKEN + SPACE_ENDPOINT come from local; other local keys are ignored.
    await chromeMock.storage.local.set({ [STORAGE.MODEL]: "local-should-be-ignored" });
    const config = await loadConfig();
    expect(config[STORAGE.MODEL]).toBe(DEFAULTS[STORAGE.MODEL]);
  });
});

describe("saveConfig — sensitive-key routing", () => {
  it("writes sensitive keys (token + endpoint) to storage.local only", async () => {
    await saveConfig({
      [STORAGE.TOKEN]: "tok-123",
      [STORAGE.SPACE_ENDPOINT]: "https://endpoint.zo.space",
    });
    expect(chromeMock.storage.local[STORAGE.TOKEN]).toBeUndefined(); // internal store is private
    // But reading it back through the mock returns what was written.
    const local = await new Promise<any>((r) =>
      chromeMock.storage.local.get([STORAGE.TOKEN, STORAGE.SPACE_ENDPOINT], r));
    expect(local[STORAGE.TOKEN]).toBe("tok-123");
    expect(local[STORAGE.SPACE_ENDPOINT]).toBe("https://endpoint.zo.space");
    // And NOT written to sync.
    const sync = await new Promise<any>((r) =>
      chromeMock.storage.sync.get([STORAGE.TOKEN, STORAGE.SPACE_ENDPOINT], r));
    expect(sync[STORAGE.TOKEN]).toBeUndefined();
    expect(sync[STORAGE.SPACE_ENDPOINT]).toBeUndefined();
  });

  it("writes non-sensitive keys to storage.sync only", async () => {
    await saveConfig({
      [STORAGE.MODEL]: "zo-lite",
      [STORAGE.ACTIVE_MODE]: "ask",
    });
    const sync = await new Promise<any>((r) =>
      chromeMock.storage.sync.get([STORAGE.MODEL, STORAGE.ACTIVE_MODE], r));
    expect(sync[STORAGE.MODEL]).toBe("zo-lite");
    expect(sync[STORAGE.ACTIVE_MODE]).toBe("ask");
    const local = await new Promise<any>((r) =>
      chromeMock.storage.local.get([STORAGE.MODEL, STORAGE.ACTIVE_MODE], r));
    expect(local[STORAGE.MODEL]).toBeUndefined();
    expect(local[STORAGE.ACTIVE_MODE]).toBeUndefined();
  });

  it("splits a mixed payload across both areas", async () => {
    await saveConfig({
      [STORAGE.TOKEN]: "tok",
      [STORAGE.MODEL]: "m",
    });
    const local = await new Promise<any>((r) =>
      chromeMock.storage.local.get([STORAGE.TOKEN], r));
    const sync = await new Promise<any>((r) =>
      chromeMock.storage.sync.get([STORAGE.MODEL], r));
    expect(local[STORAGE.TOKEN]).toBe("tok");
    expect(sync[STORAGE.MODEL]).toBe("m");
  });

  it("round-trips: save → load returns the saved values", async () => {
    await saveConfig({
      [STORAGE.TOKEN]: "round-trip-tok",
      [STORAGE.SPACE_ENDPOINT]: "https://rt.zo.space",
      [STORAGE.MODEL]: "rt-model",
      [STORAGE.ACTIVE_MODE]: "extract",
    });
    const config = await loadConfig();
    expect(config[STORAGE.TOKEN]).toBe("round-trip-tok");
    expect(config[STORAGE.SPACE_ENDPOINT]).toBe("https://rt.zo.space");
    expect(config[STORAGE.MODEL]).toBe("rt-model");
    expect(config[STORAGE.ACTIVE_MODE]).toBe("extract");
  });

  it("resolves even for an empty payload (no writes, no throw)", async () => {
    // Empty payload → no storage writes → resolves (Promise.all([]) → []) cleanly.
    await expect(saveConfig({})).resolves.toBeDefined();
    // And nothing was persisted to either area.
    const allSync = await new Promise<any>((r) => chromeMock.storage.sync.get(null, r));
    const allLocal = await new Promise<any>((r) => chromeMock.storage.local.get(null, r));
    expect(Object.keys(allSync)).toEqual([]);
    expect(Object.keys(allLocal)).toEqual([]);
  });
});

describe("watchConfig — change subscription", () => {
  it("fires immediately with the current config on subscribe", async () => {
    const seen: any[] = [];
    const { watchConfig } = await import("../extension/lib/config.js");
    watchConfig((config: any) => seen.push(config));
    // The immediate fire is async (loadConfig then handler) — wait a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0][STORAGE.ACTIVE_MODE]).toBe(DEFAULTS[STORAGE.ACTIVE_MODE]);
  });

  it("reloads config and calls the handler when a relevant key changes", async () => {
    const { watchConfig } = await import("../extension/lib/config.js");
    const seen: any[] = [];
    watchConfig((config: any) => seen.push(config));
    await new Promise((r) => setTimeout(r, 0)); // drain immediate fire
    seen.length = 0;

    // Simulate chrome.storage.onChanged firing for a tracked key.
    // Persist the value first so loadConfig (called by the handler) sees it.
    await chromeMock.storage.sync.set({ [STORAGE.MODEL]: "changed-model" });
    chromeMock.storage.onChanged.__fire(
      { [STORAGE.MODEL]: { newValue: "changed-model" } },
      "sync",
    );
    await new Promise((r) => setTimeout(r, 10)); // loadConfig → handler
    expect(seen.length).toBeGreaterThanOrEqual(1);
    // The handler received a freshly-loaded config carrying the new value.
    expect(seen[seen.length - 1][STORAGE.MODEL]).toBe("changed-model");
  });

  it("ignores changes to keys that are not in DEFAULTS", async () => {
    const { watchConfig } = await import("../extension/lib/config.js");
    const seen: any[] = [];
    watchConfig((config: any) => seen.push(config));
    await new Promise((r) => setTimeout(r, 0));
    seen.length = 0;

    chromeMock.storage.onChanged.__fire(
      { someUnknownKey: { newValue: "x" } },
      "sync",
    );
    await new Promise((r) => setTimeout(r, 10));
    // No relevant key changed → handler not called again.
    expect(seen.length).toBe(0);
  });
});
