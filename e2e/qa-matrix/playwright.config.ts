import { defineConfig } from "@playwright/test";

// QA-matrix Playwright project — the QA agent's deterministic lane (0.2.8
// bash tooling). Mirrors e2e/playwright.config.ts (same mock-zo webServer,
// same extension harness) but lives in its own project so the PR-gating
// `bun run test:e2e` suite stays fast; QA rounds run the matrix on demand.
//
//   Run: bun run qa:matrix
//
// A RED matrix spec is a FINDING, not a broken test: record it in
// docs/qa/findings/ per docs/qa/agent-playbook.md, then mark the spec
// test.fixme() with the finding key.

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  fullyParallel: false, // one browser profile; specs share the extension
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "report", open: "never" }]],
  use: {
    // Tracing must stay OFF: Playwright's CDP tracer contends with the
    // extension's chrome.debugger fast-path and silently breaks background
    // stream accumulation on tab close (m1 caught this — finding
    // qa-stream-accumulation-debugger-conflict). Failure screenshots are fine.
    trace: "off",
    screenshot: "only-on-failure",
  },
  outputDir: "results",
  webServer: {
    command: "node ../mock-zo/server.mjs",
    url: "http://127.0.0.1:3179/__health",
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
