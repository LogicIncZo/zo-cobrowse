import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "acorn";

const OPTIONS_PATH = resolve(import.meta.dir, "../extension/options.js");
const OPTIONS_HTML_PATH = resolve(import.meta.dir, "../extension/options.html");

describe("options.js", () => {
  const code = readFileSync(OPTIONS_PATH, "utf-8");

  it("is valid JavaScript", () => {
    expect(() => parse(code, { ecmaVersion: "latest" })).not.toThrow();
  });

  it("loads saved config on DOMContentLoaded", () => {
    expect(code).toContain("DOMContentLoaded");
    expect(code).toContain("chrome.storage.sync.get");
  });

  it("saves config on form submit", () => {
    expect(code).toContain("addEventListener");
    expect(code).toContain("chrome.storage.sync.set");
    expect(code).toContain("access-token");
    expect(code).toContain("model");
  });

  it("fetches models from API when token is saved", () => {
    expect(code).toContain("populateModels");
    expect(code).toContain("models/available");
  });

  it("has a test connection button", () => {
    expect(code).toContain("testBtn");
    expect(code).toContain("test-btn");
    expect(code).toContain("fetch");
  });

it("has screenshot toggle in UI", () => {
    expect(code).toContain("enable-screenshots");
    expect(code).toContain("Screenshot");
    expect(code).toContain("enableScreenshots");
  });

  it("shows status messages", () => {
    expect(code).toContain("statusMsg");
    expect(code).toContain("status-message");
  });

  it("has reset-to-defaults that clears sync + local config (#B-15)", () => {
    expect(code).toContain("reset-defaults");
    expect(code).toContain("chrome.storage.sync.remove");
    expect(code).toContain("chrome.storage.local.remove");
    expect(code).toContain("zoAccessToken");
    expect(code).toContain("location.reload");
  });
});

describe("options.html shortcuts", () => {
  const html = readFileSync(OPTIONS_HTML_PATH, "utf-8");

  it("documents shortcuts that match manifest commands (#B-14)", () => {
    // Manifest declares _execute_action=Z, summarize-page=S, new-chat=N, extract-page=E
    expect(html).toContain("Ctrl+Shift+Z");
    expect(html).toContain("Ctrl+Shift+S");
    expect(html).toContain("Ctrl+Shift+N");
    expect(html).toContain("Ctrl+Shift+E");
    // The stale/incorrect K and L shortcuts must be gone
    expect(html).not.toContain("Ctrl+Shift+K");
    expect(html).not.toContain("Ctrl+Shift+L");
  });

  it("has a reset button", () => {
    expect(html).toContain('id="reset-defaults"');
  });
});

describe("options Prompts editor (mode tuning)", () => {
  const html = readFileSync(OPTIONS_HTML_PATH, "utf-8");
  const code = readFileSync(resolve(import.meta.dir, "../extension/options.js"), "utf-8");

  it("renders the Prompts card with the 5 mode knobs + live preview", () => {
    expect(html).toContain("✎ Prompts");
    expect(html).toContain('id="prompt-mode-select"');
    expect(html).toContain('id="prompt-system"');
    expect(html).toContain('id="prompt-instructions"');
    expect(html).toContain('id="prompt-tier"');
    expect(html).toContain('id="prompt-budget"');
    expect(html).toContain('id="prompt-json"');
    expect(html).toContain('id="prompt-preview-pre"');
  });

  it("saves built-in edits to the overrides catalog and customs to cobrowse_modes", () => {
    // Built-ins → cobrowse_mode_overrides (sparse, per-id); customs → cobrowse_modes.
    expect(code).toContain("cobrowse_mode_overrides");
    expect(code).toContain("cobrowse_modes");
    expect(code).toContain("mergeOverride");
    expect(code).toContain("describePrompt");
    expect(code).toContain("EDITABLE_MODE_FIELDS");
    // Dynamic import (keeps options.js a classic script the suite parses).
    expect(code).toContain("import('./lib/modes.js')");
    expect(code).toContain("import('./lib/prompt.js')");
  });

  it("resets built-in overrides via Reset to defaults", () => {
    expect(code).toContain("cobrowse_mode_overrides"); // cleared in reset localKeys
  });
});
