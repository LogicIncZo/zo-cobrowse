// E2E: conversation-id debug tooling (0.2.8.0) — the #con_… copy chip on
// assistant footers, ↗ Open in Zo deep links, the same actions on history
// cards, and the Zo Web Origin field in Settings (save + validation).
//
// The mock Zo server echoes `x-conversation-id: con_e2e-conv-1` on every
// stream, so a real turn gives the panel a real-shaped Zo thread id.

import { test, expect } from "@playwright/test";
import {
  openHarness,
  sendQuery,
  waitForTurnComplete,
  type ExtensionHarness,
} from "./helpers/extension";

let h: ExtensionHarness;

test.beforeAll(async () => {
  h = await openHarness({ freshProfile: true });
  await h.context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // Configure the Zo web origin live through storage.sync — the panel's
  // storage.onChanged handler picks it up without a reload (same path a
  // real Settings save takes while the panel is open).
  await h.panel.evaluate(
    () =>
      new Promise<void>((resolve) => {
        chrome.storage.sync.set({ zoWebOrigin: "http://127.0.0.1:3179" }, () => resolve());
      }),
  );
  await h.panel.waitForTimeout(300);
});

test.afterAll(async () => {
  await h?.context.close();
});

test.describe("zo-links (0.2.8.0)", () => {
  test("assistant footer: #con_… chip copies the full id; ↗ opens the Zo chat URL", async () => {
    await sendQuery(h.panel, "what is this page?");
    await waitForTurnComplete(h.panel, 20_000);

    const chip = h.panel.locator("#messages .msg-assistant .msg-footer-convid").last();
    await expect(chip).toHaveText("#con_e2e-co…"); // truncateId display form
    expect(await chip.getAttribute("title")).toContain("con_e2e-conv-1");

    // Click → real clipboard write of the FULL id.
    await chip.click();
    await expect(chip).toHaveText("Copied ✓");
    const clip = await h.panel.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe("con_e2e-conv-1");

    // ↗ Open in Zo opens a real tab at the deep link (mock origin — loads).
    const openBtn = h.panel.locator("#messages .msg-assistant .msg-footer-zolink").last();
    await expect(openBtn).toHaveCount(1);
    const pagePromise = h.context.waitForEvent("page");
    await openBtn.click();
    const zoTab = await pagePromise;
    await zoTab.waitForLoadState("domcontentloaded").catch(() => {});
    expect(zoTab.url()).toContain("/?chat=con_e2e-conv-1&t=chats");
    await zoTab.close();
  });

  test("history card: copy-id + Open in Zo join the card actions", async () => {
    await h.panel.locator("#history-btn").click();
    const card = h.panel.locator("#history-list .history-card").first();

    const copyIdBtn = card.locator("button[title*='copy Zo conversation id']");
    await expect(copyIdBtn).toBeVisible();
    await copyIdBtn.click();
    await expect(copyIdBtn).toHaveText("✓");
    const clip = await h.panel.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe("con_e2e-conv-1");

    const openBtn = card.locator("button[title='Open in Zo']");
    await expect(openBtn).toBeVisible();
    const pagePromise = h.context.waitForEvent("page");
    await openBtn.click();
    const zoTab = await pagePromise;
    await zoTab.waitForLoadState("domcontentloaded").catch(() => {});
    expect(zoTab.url()).toContain("/?chat=con_e2e-conv-1&t=chats");
    await zoTab.close();

    await h.panel.locator("#back-to-chat-btn").click(); // back to chat view
  });

  test("options: Zo Web Origin field validates http(s) and saves", async () => {
    const page = await h.context.newPage();
    await page.goto(`chrome-extension://${h.extensionId}/options.html`);

    // Non-empty must be a real http(s) URL — Save flags it, nothing persists.
    await page.locator("#zo-web-origin").fill("not a url");
    await page.locator("#card-connection button[type=submit]").click();
    await expect(page.locator("#status-message")).toContainText("Zo Web Origin");

    // Valid value saves (token is pre-seeded by the harness).
    await page.locator("#zo-web-origin").fill("https://cashlessconsumer.zo.computer");
    await page.locator("#card-connection button[type=submit]").click();
    await expect(page.locator("#status-message")).toContainText("Saved");
    const stored = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          chrome.storage.sync.get("zoWebOrigin", (v: any) => resolve(v.zoWebOrigin));
        }),
    );
    expect(stored).toBe("https://cashlessconsumer.zo.computer");
    await page.close();
  });
});
