import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ManifestSchema, type Manifest } from "./schemas/manifest.js";

const MANIFEST_PATH = resolve(import.meta.dir, "../extension/manifest.json");

describe("manifest.json — full schema validation", () => {
  const raw = readFileSync(MANIFEST_PATH, "utf-8");
  const parsed = ManifestSchema.safeParse(JSON.parse(raw));

  it("parses cleanly against the Zod schema", () => {
    if (!parsed.success) {
      throw new Error("manifest.json failed schema validation:\n" + parsed.error.message);
    }
    expect(parsed.success).toBe(true);
  });

  // From here on, `manifest` is the schema-validated object.
  const manifest: Manifest = parsed.success ? parsed.data : ({} as Manifest);

  it("is Chrome MV3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("requires all host permissions are present", () => {
    expect(manifest.host_permissions).toContain("https://api.zo.computer/*");
    expect(manifest.host_permissions).toContain("https://*.zo.space/*");
  });

  it("icons exist at 16/48/128 and reference PNG files", () => {
    expect(manifest.icons["16"]).toMatch(/\.png$/);
    expect(manifest.icons["48"]).toMatch(/\.png$/);
    expect(manifest.icons["128"]).toMatch(/\.png$/);
  });

  // ── Ticket #06: Keyboard Shortcuts ──
  it("registers all four keyboard commands", () => {
    expect(manifest.commands).toHaveProperty("_execute_action");
    expect(manifest.commands).toHaveProperty("summarize-page");
    expect(manifest.commands).toHaveProperty("new-chat");
    expect(manifest.commands).toHaveProperty("extract-page");
  });

  it("every command has a default + mac suggested key", () => {
    for (const [name, cmd] of Object.entries(manifest.commands)) {
      expect(cmd.suggested_key.default, `${name} missing default key`).toBeTruthy();
      expect(cmd.suggested_key.mac, `${name} missing mac key`).toBeTruthy();
    }
  });

  // ── Ticket #13: Omnibox ──
  it("has omnibox keyword 'zo'", () => {
    expect(manifest.omnibox.keyword).toBe("zo");
  });

  // ── Write-assist widget (feature/textarea-fill) ──
  it("exposes icons/icon.svg to host pages (in-page Zo icon)", () => {
    const war = manifest.web_accessible_resources || [];
    const entry = war.find((w) => w.resources.includes("icons/icon.svg"));
    expect(entry).toBeTruthy();
    expect(entry!.matches).toContain("<all_urls>");
  });
});
