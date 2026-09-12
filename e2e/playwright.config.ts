import { defineConfig } from "@playwright/test";

// Real-Chromium E2E for the zo-cobrowse extension.
//
//   • launchPersistentContext with --load-extension (MV3-compatible "new" headless)
//   • webServer boots the mock Zo API (SSE over real HTTP) + the static fixture site
//   • specs open chrome-extension://<id>/sidepanel.html as a tab (the true
//     side-panel shell isn't drivable over CDP — documented workaround)
//
// Run: bun run test:e2e   (headed: bun run test:e2e:headed)

export default defineConfig({
  testDir: ".",
  // The QA matrix is its own on-demand project (e2e/qa-matrix/, own config:
  // `bun run qa:matrix`) — never part of the PR-gating suite.
  testIgnore: ["qa-matrix/**"],
  timeout: 30_000,
  fullyParallel: false, // one browser profile; tests share the extension
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "report", open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  outputDir: "results",
  webServer: {
    command: "node mock-zo/server.mjs",
    url: "http://127.0.0.1:3179/__health",
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
