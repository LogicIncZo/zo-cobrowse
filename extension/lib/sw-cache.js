/**
 * MV3 service-worker cache that survives worker restarts (#73): a
 * memory-first wrapper over ONE chrome.storage.session key. The SW is killed
 * after ~30s idle — plain in-memory TTL caches (skills list, model catalog)
 * were wiped on every restart, so e.g. the `/` skills picker re-fetched and
 * showed "Loading skills…" on essentially every open.
 *
 * Pure: `storage` is injected (a storage AREA — `chrome.storage.session` in
 * production — anything with get(key)/set(obj)), so this
 * unit-tests without chrome. `null`/`undefined` values are treated as a MISS
 * — a fetcher that fails by returning null is retried next call, never cached.
 *
 * @param {{
 *   storage: { get(key: string): Promise<object>, set(obj: object): Promise<void> },
 *   key: string,
 *   ttlMs: number,
 *   now?: () => number,
 * }} opts
 * @returns {{ get(fetcher: () => Promise<any>, force?: boolean): Promise<any>, invalidate(): void }}
 */
export function createSessionCache({ storage, key, ttlMs, now = Date.now }) {
  let mem = { value: undefined, fetchedAt: 0, inFlight: null };

  const fresh = (fetchedAt) => now() - fetchedAt < ttlMs;

  async function readStored() {
    try {
      const bag = await storage.get(key);
      const entry = bag && bag[key];
      if (entry && entry.value !== null && entry.value !== undefined && fresh(entry.fetchedAt)) {
        return entry;
      }
    } catch {
      // session storage unavailable (tests, hardened browsers) — fetch below
    }
    return null;
  }

  return {
    async get(fetcher, force = false) {
      if (!force && mem.value !== null && mem.value !== undefined && fresh(mem.fetchedAt)) {
        return mem.value;
      }
      if (mem.inFlight) return mem.inFlight;
      mem.inFlight = (async () => {
        if (!force) {
          const entry = await readStored();
          if (entry) {
            mem.value = entry.value;
            mem.fetchedAt = entry.fetchedAt;
            return entry.value;
          }
        }
        const value = await fetcher();
        mem.value = value;
        mem.fetchedAt = now();
        if (value !== null && value !== undefined) {
          try {
            await storage.set({ [key]: { value, fetchedAt: mem.fetchedAt } });
          } catch {
            // cache write is best-effort
          }
        }
        return value;
      })();
      try {
        return await mem.inFlight;
      } finally {
        mem.inFlight = null;
      }
    },
    invalidate() {
      mem = { value: undefined, fetchedAt: 0, inFlight: null };
    },
  };
}
