// E2E: the options page — Test Connection, the Prompts editor's live preview,
// and Reset-to-defaults — against the mock endpoints.
//
// seedExtensionConfig seeds zoApiUrl = ${E2E_BASE}/zo/ask, and Test Connection
// (plus the model/persona loaders) derive from that configured endpoint —
// never the hardcoded prod host (QA finding B). Test 1 asserts prod is
// NEVER hit.

import { test, expect } from "@playwright/test";
import { launchExtension, seedExtensionConfig, E2E_BASE } from "./helpers/extension";

test.describe("options page", () => {
  test("Test Connection hits the CONFIGURED endpoint, not hardcoded prod (QA finding B)", async () => {
    const { context, extensionId, serviceWorker } = await launchExtension({ freshProfile: true });
    try {
      await seedExtensionConfig(serviceWorker);
      const page = await context.newPage();
      // The configured endpoint answers; any prod-host request is a FAILURE
      // signal — the field must drive the fetch.
      let prodHit = false;
      await page.route("https://api.zo.computer/**", (route) => {
        prodHit = true;
        return route.fulfill({ status: 500, contentType: "text/plain", body: "prod must not be called" });
      });
      await page.route(`${E2E_BASE}/zo/ask`, (route) =>
        route.fulfill({ status: 200, contentType: "text/plain", body: "ZO_OK" }),
      );
      await page.goto(`chrome-extension://${extensionId}/options.html`);

      // The Connection pane shows the configured endpoint in the new field.
      await expect(page.locator("#access-token")).toHaveValue(/.+/);
      await expect(page.locator("#api-endpoint")).toHaveValue(`${E2E_BASE}/zo/ask`);

      // Test Connection goes green against the configured URL.
      await page.click("#test-btn");
      await expect(page.locator("#status-message")).toContainText("Connection successful", { timeout: 10_000 });
      await expect(page.locator("#status-message")).toHaveClass(/ok/);
      expect(prodHit).toBe(false);

      // Saving persists the endpoint (storage.sync, non-sensitive).
      await page.click("button[type=submit]");
      await expect(page.locator("#status-message")).toContainText("Saved");
      const stored = await serviceWorker.evaluate(() =>
        new Promise((r) => chrome.storage.sync.get("zoApiUrl", (v) => r(v.zoApiUrl))),
      );
      expect(stored).toBe(`${E2E_BASE}/zo/ask`);
    } finally {
      await context.close();
    }
  });

  test("Prompts editor previews the built prompt and saves overrides", async () => {
    const { context, extensionId, serviceWorker } = await launchExtension({ freshProfile: true });
    try {
      await seedExtensionConfig(serviceWorker);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);

      // The editor lives in the Prompts tab — open it first.
      await page.click(`#settings-nav .settings-tab[data-pane="pane-prompts"]`);
      await expect(page.locator("#pane-prompts")).toBeVisible();

      // The editor loads Modes via dynamic import; the preview paints
      const pre = page.locator("#prompt-preview-pre");
      await expect(pre).toContainText("You are Zo", { timeout: 10_000 });

      // Editing instructions updates the live preview
      const instr = page.locator("#prompt-instructions");
      await instr.fill("E2E INSTRUCTIONS MARKER");
      await expect(pre).toContainText("E2E INSTRUCTIONS MARKER", { timeout: 5_000 });

      // Save persists a sparse override (original built-ins untouched)
      await page.click("#prompt-save");
      await expect(page.locator("#prompt-status")).toContainText(/saved/i, { timeout: 5_000 });
      const stored = await serviceWorker.evaluate(() =>
        new Promise((r) => chrome.storage.local.get("cobrowse_mode_overrides", (v) => r(v.cobrowse_mode_overrides))),
      );
      expect(stored).toBeTruthy();

      // Reset-to-original deletes the override entry
      await page.click("#prompt-reset");
      await expect(page.locator("#prompt-status")).toContainText(/reset|original/i, { timeout: 5_000 });
      const afterReset = await serviceWorker.evaluate(() =>
        new Promise((r) => chrome.storage.local.get("cobrowse_mode_overrides", (v) => r(v.cobrowse_mode_overrides))),
      );
      expect(afterReset ?? {}).toEqual({});
    } finally {
      await context.close();
    }
  });

  test("settings usability: section tabs, token reveal, runtime version, dirty indicator", async () => {
    const { context, extensionId, serviceWorker } = await launchExtension({ freshProfile: true });
    try {
      await seedExtensionConfig(serviceWorker);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);

      // Tabbed UI: every tab button has a pane; clicking shows exactly that
      // pane (others hidden); the last tab persists across a reload.
      const tabButtons = page.locator("#settings-nav .settings-tab");
      await expect(tabButtons.first()).toBeVisible();
      const count = await tabButtons.count();
      expect(count).toBeGreaterThanOrEqual(5);
      await expect(page.locator("#pane-connection")).toBeVisible();
      await tabButtons.nth(3).click(); // Features
      await expect(page.locator("#pane-features")).toBeVisible();
      await expect(page.locator("#pane-connection")).toBeHidden();
      await expect(page.locator("#card-features")).toBeVisible();
      await expect(page.locator("#card-write")).toBeVisible();
      await page.reload();
      await expect(page.locator("#pane-features")).toBeVisible();
      await expect(page.locator("#pane-connection")).toBeHidden();
      // A #card-* deep link still lands on the right pane.
      await page.goto(`chrome-extension://${extensionId}/options.html#card-about`);
      await expect(page.locator("#pane-about")).toBeVisible();
      await expect(page.locator("#card-about")).toBeVisible();

      // Token reveal: password by default, toggles to text and back (the
      // token field lives in the Connection pane — switch back to it).
      await page.click(`#settings-nav .settings-tab[data-pane="pane-connection"]`);
      await expect(page.locator("#access-token")).toHaveAttribute("type", "password");
      await page.click("#token-toggle");
      await expect(page.locator("#access-token")).toHaveAttribute("type", "text");
      await expect(page.locator("#token-toggle")).toHaveText("Hide");
      await page.click("#token-toggle");
      await expect(page.locator("#access-token")).toHaveAttribute("type", "password");

      // Version comes from the live manifest, not a hardcoded string.
      await page.click(`#settings-nav .settings-tab[data-pane="pane-about"]`);
      await expect(page.locator("#ext-version")).toHaveText(/^v\d+\.\d+/, { timeout: 5_000 });

      // Dirty indicator: editing a form-only field flags the Save buttons;
      // saving clears it (and the toast is visible — fixed position).
      await page.click(`#settings-nav .settings-tab[data-pane="pane-connection"]`);
      await expect(page.locator("button[type=submit].save-dirty")).toHaveCount(0);
      await page.fill("#space-endpoint", "https://example.zo.space");
      await expect(page.locator("button[type=submit].save-dirty").first()).toBeVisible();
      await page.click("button[type=submit]");
      await expect(page.locator("#status-message")).toContainText("Saved");
      await expect(page.locator("button[type=submit].save-dirty")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("TTS voice picker: honest zero-voice state (#64)", async () => {
    const { context, extensionId } = await launchExtension({ freshProfile: true });
    try {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      await page.click(`#settings-nav .settings-tab[data-pane="pane-features"]`);
      const voice = page.locator("#tts-voice");
      await expect(voice).toBeVisible();
      // Headless Chromium ships zero TTS voices — the picker says so instead
      // of offering a bare "System default" that silently does nothing.
      await expect(voice).toBeDisabled();
      await expect(page.locator("#tts-voice-hint")).toContainText("No TTS voices");
    } finally {
      await context.close();
    }
  });
});
