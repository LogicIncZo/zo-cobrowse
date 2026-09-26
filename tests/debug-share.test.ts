// Unit: lib/debug-share.js — the diagnostics-share pure half. The
// load-bearing part is the privacy posture: allowlisted settings only,
// scrubbed strings, no page text/tokens/identifying config in the bundle,
// and an upload path that is user-triggered, anonymous, and 24h-expiry.
import { describe, it, expect } from "bun:test";
import {
  redactUrl,
  scrubText,
  buildDiagnosticsBundle,
  uploadDiagnostics,
  PASTE_HOSTS,
  SETTINGS_SNAPSHOT_KEYS,
  DIAG_SHARE_EXPIRY_MS,
} from "../extension/lib/debug-share.js";
import { UploadResultSchema, PasteHostSchema, ShareDiagnosticsResponseSchema } from "./schemas/debug-share.ts";

describe("redactUrl", () => {
  it("keeps origin+path, drops query and hash (tokens/session keys live there)", () => {
    expect(redactUrl("https://example.dev/a/b?token=secret&q=1#frag")).toBe("https://example.dev/a/b");
  });
  it("rejects non-http schemes and garbage", () => {
    expect(redactUrl("chrome-extension://abc/options.html")).toBe("");
    expect(redactUrl("not a url")).toBe("");
    expect(redactUrl("")).toBe("");
  });
});

describe("scrubText", () => {
  it("collapses URLs to their redacted form", () => {
    expect(scrubText("failed to reach https://host.dev/p?x=1 for you")).toBe("failed to reach https://host.dev/p for you");
  });
  it("blanks long opaque runs (tokens, ids, signatures) but keeps prose", () => {
    expect(scrubText("conv_ab12cd34ef56gh78ij90kl12mn34op56 leaked")).toBe("«id» leaked");
    expect(scrubText("a low-confidence pick")).toBe("a low-confidence pick");
  });
  it("truncates prose at 200 chars; long opaque runs collapse instead", () => {
    expect(scrubText("word ".repeat(100))).toHaveLength(200);
    expect(scrubText("x".repeat(500))).toBe("«id»");
  });
});

describe("buildDiagnosticsBundle", () => {
  const base = {
    version: "0.3.6.0",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Test/1",
    sessionId: "11111111-2222-3333-4444-555555555555",
    now: 1790412000000,
  };

  it("renders header, allowlisted settings, and relative-time events", () => {
    const text = buildDiagnosticsBundle({
      ...base,
      entries: [
        { ts: base.now, kind: "capture", label: "getActiveTabContext", durMs: 12.3, extra: { tier: 2 } },
        { ts: base.now + 2500, kind: "stream", label: "askZoStream:done", durMs: 410, traceId: "turn-1:chat-1" },
      ],
      dropped: 2,
      enabled: true,
      settings: { debugMode: true, jevEnabled: true, jevPickConfidence: 0.8, domContextEnabled: false },
    });
    expect(text).toContain("# Zo Co-browse diagnostics — anonymous, metadata-only");
    expect(text).toContain("extension: 0.3.6.0");
    expect(text).toContain("debugMode: on · events: 2 · 2 dropped (ring full)");
    expect(text).toContain("jevEnabled: true");
    expect(text).toContain("+2.5s [stream] askZoStream:done (410ms) trace=turn-1:chat-1");
  });

  it("PRIVACY: settings outside the allowlist never render, even if passed", () => {
    const text = buildDiagnosticsBundle({
      ...base,
      entries: [],
      settings: {
        zoAccessToken: "sk-super-secret",
        zoModel: "byok:e4ad4825-9909-42a4-b022-f83234b92064", // user-identifying uuid
        zoWebOrigin: "https://someuser.zo.computer",           // user slug
        jevApiKey: "jev-key",
        debugMode: true,
        zoSpaceEndpoint: "https://someuser.zo.space",
      },
    });
    expect(text).not.toContain("sk-super-secret");
    expect(text).not.toContain("byok:");
    expect(text).not.toContain("someuser");
    expect(text).not.toContain("jev-key");
    expect(text).toContain("debugMode: true");
  });

  it("PRIVACY: string extras are scrubbed (URLs collapsed, opaque runs redacted)", () => {
    const text = buildDiagnosticsBundle({
      ...base,
      entries: [{
        ts: base.now,
        kind: "navigate",
        label: "tabs.update",
        extra: { error: "boom https://private.dev/p?q=9", token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      }],
      settings: {},
    });
    expect(text).not.toContain("q=9");
    expect(text).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(text).toContain("https://private.dev/p");
    expect(text).toContain("token=«id»");
  });

  it("renders an explicit empty marker when no events exist", () => {
    const text = buildDiagnosticsBundle({ ...base, entries: [], settings: {} });
    expect(text).toContain("(no events recorded)");
  });
});

describe("PASTE_HOSTS", () => {
  it("every host matches the schema contract (anonymous, name+endpoint+bodyType)", () => {
    for (const h of PASTE_HOSTS) {
      const r = PasteHostSchema.safeParse(h);
      if (!r.success) throw new Error(`host drift: ${r.error.issues.map((i: any) => i.message).join("; ")}`);
    }
  });
  it("the settings allowlist is non-empty and holds no secret keys", () => {
    expect(SETTINGS_SNAPSHOT_KEYS.length).toBeGreaterThan(0);
    for (const k of SETTINGS_SNAPSHOT_KEYS) {
      expect(/token|key|secret/i.test(k)).toBe(false);
    }
  });
});

describe("uploadDiagnostics", () => {
  const text = "# bundle\n+0.0s [msg] ASK_ZO";
  const now = 1790412000000;

  it("posts to dpaste.com first WITH the urlencoded content-type header (the 400 bug) and returns the parsed URL", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response("https://dpaste.com/ABC123", { status: 201 });
    };
    const r = await uploadDiagnostics(text, { fetchImpl, now });
    const parsed = UploadResultSchema.parse(r);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.host).toBe("dpaste.com");
      expect(parsed.url).toBe("https://dpaste.com/ABC123");
      expect(parsed.expiresAt).toBe(now + DIAG_SHARE_EXPIRY_MS);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://dpaste.com/api/v2/");
    // Regression: a string body without this header goes out as text/plain —
    // dpaste answers 400 "Missing required field 'content'".
    expect(calls[0].init.headers).toMatchObject({ "content-type": "application/x-www-form-urlencoded" });
    const form = new URLSearchParams(calls[0].init.body as string);
    expect(form.get("expiry_days")).toBe("1");
    expect(form.get("content")).toBe(text);
  });

  it("falls back to paste.debian.net — JSON body with expire=86400, url pulled from the JSON reply", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = async (url: string, init: any) => {
      calls.push({ url, init });
      if (calls.length === 1) return new Response("gone", { status: 507 });
      return new Response(JSON.stringify({ id: "49b5624d", url: "https://paste.debian.net/hidden/49b5624d", expires: 86400 }), { status: 200 });
    };
    const r = await uploadDiagnostics(text, { fetchImpl, now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe("paste.debian.net");
      expect(r.url).toBe("https://paste.debian.net/hidden/49b5624d");
      expect(r.expiresAt).toBe(now + DIAG_SHARE_EXPIRY_MS);
    }
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://paste.debian.net/api/v1/paste");
    expect(calls[1].init.headers).toMatchObject({ "content-type": "application/json" });
    const body = JSON.parse(calls[1].init.body as string);
    expect(body).toMatchObject({ code: text, lang: "text", expire: 86400 });
  });

  it("a debian 2xx whose JSON has no url is a failure, not a poisoned link", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response('{"id":"x"}', { status: 200 });
    };
    const r = await uploadDiagnostics(text, { fetchImpl, now });
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain("paste.debian.net: unexpected response");
  });

  it("all hosts failing collapses into one combined error (never throws)", async () => {
    const fetchImpl = async () => new Response("nope", { status: 500 });
    const r = await uploadDiagnostics(text, { fetchImpl, now });
    const parsed = UploadResultSchema.parse(r);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("dpaste.com: HTTP 500");
      expect(parsed.error).toContain("paste.debian.net: HTTP 500");
    }
  });

  it("a 2xx with a non-URL body is a failure, not a poisoned link", async () => {
    const fetchImpl = async () => new Response('{"output":"ok"}', { status: 200 });
    const r = await uploadDiagnostics(text, { fetchImpl, now });
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain("unexpected response");
  });

  it("empty input short-circuits honestly", async () => {
    let called = 0;
    const fetchImpl = async () => { called++; return new Response("x", { status: 200 }); };
    const r = await uploadDiagnostics("   ", { fetchImpl, now });
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });

  it("ShareDiagnosticsResponseSchema accepts both shapes the background can return", () => {
    expect(ShareDiagnosticsResponseSchema.safeParse({ ok: true, url: "https://dpaste.com/ABC123", host: "dpaste.com", expiresAt: 1 }).success).toBe(true);
    expect(ShareDiagnosticsResponseSchema.safeParse({ ok: false, error: "dpaste.com: HTTP 500" }).success).toBe(true);
    expect(ShareDiagnosticsResponseSchema.safeParse({ ok: true }).success).toBe(false); // ok without url is not a success
    expect(ShareDiagnosticsResponseSchema.safeParse({ ok: false, url: "https://dpaste.com/ABC123" }).success).toBe(false);
  });
});
