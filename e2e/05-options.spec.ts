// E2E: the options page — Test Connection, the Prompts editor's live preview,
// and Reset-to-defaults — against the mock endpoints.
//
// NOTE (finding): options.js's Test Connection posts to a HARDCODED
// https://api.zo.computer/zo/ask, ignoring the configured zoApiUrl — the
// spec intercepts that URL with Playwright routing to keep the test hermetic.

import { test, expect } from "@playwright/test";
import { launchExtension, seedExtensionConfig } from "./helpers/extension";

test.describe("options page", () => {
  test("Test Connection succeeds against the mocked Zo API", async () => {
    const { context, extensionId, serviceWorker } = await launchExtension({ freshProfile: true });
    try {
      await seedExtensionConfig(serviceWorker);
      const page = await context.newPage();
      // The options page fetches the hardcoded prod URL — intercept it.
      await page.route("https://api.zo.computer/zo/ask", (route) =>
        route.fulfill({ status: 200, contentType: "text/plain", body: "ZO_OK" }),
      );
      await page.route("https://cashlessconsumer.zo.space", (route) =>
        route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
      );
      await page.goto(`chrome-extension://${extensionId}/options.html`);

      // The seeded token shows as present; Test Connection goes green
      await expect(page.locator("#access-token")).toHaveValue(/.+/);
      await page.click("#test-btn");
      await expect(page.locator("#status-message")).toContainText("Connection successful", { timeout: 10_000 });
      await expect(page.locator("#status-message")).toHaveClass(/ok/);
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
