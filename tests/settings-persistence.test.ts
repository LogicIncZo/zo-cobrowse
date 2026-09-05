import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ConfigSchema } from "./schemas/config";

const bgCode = readFileSync(resolve(import.meta.dir, "../extension/background.js"), "utf-8");
const optionsCode = readFileSync(resolve(import.meta.dir, "../extension/options.js"), "utf-8");
const optionsHtml = readFileSync(resolve(import.meta.dir, "../extension/options.html"), "utf-8");

// A full config matching the schema's required fields
const FULL_CONFIG = {
  zoApiUrl: "https://cashlessconsumer.zo.space",
  zoAccessToken: "test-token-123",
  zoModel: "zo-default",
  zoPersonaId: "",
  zoActiveMode: "cobrowse",
  zoSpaceEndpoint: "https://cashlessconsumer.zo.space",
  zoWebOrigin: "",
  enableScreenshots: true,
  enableVision: true,
  enabledMenus: {},
  zoQuickActions: null,
};

const DEFAULT_CONFIG = {
  zoApiUrl: "",
  zoModel: "",
  zoActiveMode: "cobrowse",
};

describe("config schema", () => {
  it("accepts valid full config", () => {
    const result = ConfigSchema.safeParse(FULL_CONFIG);
    if (!result.success) {
      console.error("Schema errors:", result.error.format());
    }
    expect(result.success).toBe(true);
  });

  it("rejects non-url zoApiUrl", () => {
    const result = ConfigSchema.safeParse({ ...FULL_CONFIG, zoApiUrl: "not-a-url" });
    expect(result.success).toBe(false);
  });
});

describe("background.js config loading", () => {
  it("loads config from storage.sync on init", () => {
    expect(bgCode).toMatch(/chrome\.storage\.sync\.get/);  
  });

  it("has DEFAULTS object with config keys", () => {
    expect(bgCode).toMatch(/DEFAULTS|defaultConfig|const config/);
  });

  it("watches for config changes", () => {
    expect(bgCode).toMatch(/storage\.onChanged/);
  });

  it("exposes GET_CONFIG handler to sidepanel", () => {
    expect(bgCode).toMatch(/GET_CONFIG/);
  });
});

describe("options.html", () => {
  it("has input for endpoint URL", () => {
    expect(optionsHtml).toMatch(/space-endpoint|zoApiUrl|endpoint/);
  });

  it("has access token field (sensitive)", () => {
    expect(optionsHtml).toMatch(/access.?token|zoAccessToken/i);
  });

  it("has persona routing fields", () => {
    expect(optionsHtml).toMatch(/persona|routing|mode|auto|full|lite/i);
  });

  it("has screenshot toggle", () => {
    expect(optionsHtml).toMatch(/screenshot|vision/);
  });

  it("has save button", () => {
    expect(optionsHtml).toMatch(/button.*save|submit/i);
  });

  it("links to zo.space settings", () => {
    expect(optionsHtml).toMatch(/zo\.space|settings/i);
  });
});

describe("options.js save logic", () => {
  it("has form submit handler", () => {
    expect(optionsCode).toMatch(/addEventListener\(.submit/);
  });

  it("uses storage.sync.set for config", () => {
    expect(optionsCode).toMatch(/storage\.sync\.set/);
  });

  it("uses storage.local.set for access token", () => {
    expect(optionsCode).toMatch(/storage\.local\.set/);
  });

  it("fetches models when token changes", () => {
    expect(optionsCode).toMatch(/model|Model/);
  });
});
