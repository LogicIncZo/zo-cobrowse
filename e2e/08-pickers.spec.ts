// E2E: the composer reference pickers (#28) in a real Chromium — `/` opens the
// skills popup (LIST_SKILLS over the mock /mcp), selection arms a chip that
// rides the NEXT turn as a `## Skills to Run` prompt section; `%` browses the
// workspace (LIST_WORKSPACE_DIR), navigating into a directory and attaching a
// file as `## Referenced Files`. Both are send-once: chips clear after the turn.

import { test, expect } from "@playwright/test";
import { openHarness, waitForTurnComplete, recordedAsks, clearRecordedRequests } from "./helpers/extension";

/** Set the composer value + fire the input event (the trigger handlers listen on input). */
async function typeIntoComposer(panel: any, text: string) {
  await panel.evaluate((t: string) => {
    const input = document.querySelector("#query-input") as HTMLTextAreaElement;
    input.value = t;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
}

/** Press a key on the composer wrapper (the pickers' keydown handlers run on capture there). */
async function pressComposerKey(panel: any, key: string) {
  await panel.evaluate((k: string) => {
    const wrap = document.querySelector(".input-wrap") as HTMLElement;
    wrap.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  }, key);
}

test.describe("composer reference pickers (#28)", () => {
  test("/ picks a skill and % attaches a workspace file — both ride the next turn", async () => {
    const h = await openHarness({ freshProfile: true, sitePath: "/form.html" });
    try {
      await clearRecordedRequests();

      // ---- `/` skills popup ----
      await typeIntoComposer(h.panel, "/web");
      await expect(h.panel.locator("#skill-autocomplete")).toBeVisible();
      await expect(h.panel.locator("#skill-autocomplete button.picker-item").first())
        .toContainText("websh", { timeout: 10_000 });
      // Two mock skills; the filter matched websh. Select it (Enter on wrapper).
      await pressComposerKey(h.panel, "Enter");
      await expect(h.panel.locator("#picker-chips")).toBeVisible();
      await expect(h.panel.locator(".picker-chip").first()).toContainText("⚡ websh");
      // The trigger token was swallowed — composer is empty again.
      await expect.poll(async () =>
        h.panel.evaluate(() => (document.querySelector("#query-input") as HTMLTextAreaElement).value),
      ).toBe("");

      // ---- `%` files popup: browse root → into Skills → pick a file ----
      await typeIntoComposer(h.panel, "%");
      await expect(h.panel.locator("#file-autocomplete")).toBeVisible();
      await expect(h.panel.locator("#file-autocomplete button.picker-item").filter({ hasText: "Skills/" }))
        .toBeVisible({ timeout: 10_000 });
      // First selectable row is the Skills dir — Enter navigates into it.
      await pressComposerKey(h.panel, "Enter");
      await expect(h.panel.locator("#file-autocomplete button.picker-item").filter({ hasText: "README.md" }))
        .toBeVisible({ timeout: 10_000 });
      // Rows are [⬆ .., 📂 e2e-skill/, 📄 README.md] — #74: arm the FOLDER as
      // context via its ＋ affordance (row click still navigates).
      const addBtn = h.panel.locator("#file-autocomplete button.picker-item")
        .filter({ hasText: "e2e-skill" })
        .locator(".picker-item-add");
      await addBtn.click();
      await expect(h.panel.locator(".picker-chip").filter({ hasText: "📁 e2e-skill/" })).toBeVisible();

      // Reopen % — browsing resumes INSIDE Skills (filesDir persisted), so
      // pick the file directly.
      await typeIntoComposer(h.panel, "%");
      await expect(h.panel.locator("#file-autocomplete button.picker-item").filter({ hasText: "README.md" }))
        .toBeVisible({ timeout: 10_000 });
      await pressComposerKey(h.panel, "ArrowDown");
      await pressComposerKey(h.panel, "ArrowDown");
      await pressComposerKey(h.panel, "Enter");
      await expect(h.panel.locator(".picker-chip").filter({ hasText: "📄 README.md" })).toBeVisible();

      // ---- Send: both chips ride THIS turn, then clear ----
      await typeIntoComposer(h.panel, "use the references");
      await h.panel.evaluate(() => {
        const btn = document.querySelector("#send-btn") as HTMLButtonElement;
        btn.click();
      });
      await waitForTurnComplete(h.panel);

      const asks = await recordedAsks();
      const last = asks[asks.length - 1];
      expect(last.body.input).toContain("## Skills to Run");
      expect(last.body.input).toContain('"websh"');
      expect(last.body.input).toContain("read its SKILL.md");
      expect(last.body.input).toContain("## Referenced Files");
      expect(last.body.input).toContain("/home/workspace/Skills/README.md");
      // #74: the folder rides as a path; the instruction line teaches dirs.
      expect(last.body.input).toContain("/home/workspace/Skills/e2e-skill");
      expect(last.body.input).toContain("directories: list/recurse as needed");

      // Send-once: chips cleared after the turn.
      await expect(h.panel.locator("#picker-chips")).toBeHidden();
      // The user bubble carries mention pills for both picks.
      await expect(h.panel.locator(".msg-user .msg-mention").filter({ hasText: "⚡ websh" })).toBeVisible();
      await expect(h.panel.locator(".msg-user .msg-mention").filter({ hasText: "📄 README.md" })).toBeVisible();
    } finally {
      await h.context.close();
    }
  });
});
