// E2E: Recipe library panel (#257 — R3). The 🧾 Recipes popup is the library
// surface: import a workspace file, run it from the row, rename, export the
// SKILL.md bundle (documentation only), and delete (local entry only). The
// mock Zo API serves the e2e-filing recipe for the import; skill-export
// writes land in the in-memory workspace store the control endpoint exposes.

import { test, expect } from "@playwright/test";
import { E2E_BASE } from "./helpers/extension";
import { openHarness, sendQuery, type ExtensionHarness } from "./helpers/extension";

let h: ExtensionHarness;

test.beforeAll(async () => {
  h = await openHarness({ sitePath: "/index.html", freshProfile: true });
});

test.afterAll(async () => {
  await h?.context.close();
});

test.describe("recipe library", () => {
  test("import → run → rename → export → delete, all from the popup", async () => {
    test.setTimeout(120_000); // the checkpointed run alone parks for a manual payment
    await fetch(`${E2E_BASE}/__recipes`, { method: "DELETE" });

    // Fresh library: the popup opens on the 🧾 button and shows the empty state.
    await h.panel.locator("#recipe-lib-btn").click();
    const pop = h.panel.locator("#recipe-library");
    await expect(pop).not.toHaveClass(/hidden/);
    await expect(pop).toContainText("No saved recipes yet", { timeout: 10_000 });

    // Import the mock's workspace fixture → the row appears with the 🌐 badge.
    await pop.locator(".recipe-lib-import input").fill("/home/workspace/recipes/e2e-filing.json");
    await pop.locator(".recipe-lib-import button").click();
    const row = pop.locator(".recipe-lib-row", { hasText: "E2E filing" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("🌐");
    await expect(row).toContainText("applicant*"); // required param chip
    await expect(h.panel.locator("#messages .msg-system", { hasText: "Imported" })).toContainText("E2E filing");

    // ▶ Run from the row: popup closes, params card collects, run completes.
    await row.locator("button", { hasText: "Run" }).first().click();
    await expect(pop).toHaveClass(/hidden/);
    const card = h.panel.locator(".recipe-params-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.locator("input").fill("Library Value");
    await card.locator(".form-review-confirm").click();
    // The run parks at the recipe's human checkpoint — pay by hand, verify.
    const checkpoint = h.panel.locator(".recipe-checkpoint-card");
    await expect(checkpoint).toContainText("Pay ₹10", { timeout: 30_000 });
    await h.site.locator("#pay-btn").click();
    await expect(h.site).toHaveURL(/paid=1/, { timeout: 15_000 });
    await checkpoint.locator(".form-review-confirm").click();
    const done = h.panel.locator("#messages .msg-system", { hasText: "Recipe done" });
    await expect(done).toContainText("Library Value", { timeout: 30_000 }); // param flowed end to end

    // ✎ Rename: inline edit commits on Enter and re-renders the row.
    await h.panel.locator("#recipe-lib-btn").click();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator("button", { hasText: "Rename" }).click();
    // The name span swapped to an input (values aren't text) — locate it on
    // the popup, not under the now-unmatching row filter.
    const renameInput = pop.locator("input[aria-label='New name']");
    await renameInput.fill("Filing renamed");
    await renameInput.press("Enter");
    await expect(pop.locator(".recipe-lib-row", { hasText: "Filing renamed" })).toBeVisible({ timeout: 10_000 });

    // ⤓ Export: the deterministic write_file bundle lands, frontmatter intact.
    await pop.locator(".recipe-lib-row", { hasText: "Filing renamed" }).locator("button", { hasText: "Export" }).click();
    await expect(h.panel.locator("#messages .msg-system", { hasText: "Exported" })).toContainText("Skills/filing-renamed/SKILL.md", { timeout: 15_000 });
    const files: Record<string, string> = (await (await fetch(`${E2E_BASE}/__recipes`)).json()).files;
    const skill = files["/home/workspace/Skills/filing-renamed/SKILL.md"];
    expect(skill).toBeTruthy();
    expect(skill).toContain("name: filing-renamed");
    expect(skill).toContain("Filing renamed");
    expect(skill.toLowerCase()).toContain("documentation only");
    expect(files["/home/workspace/Skills/filing-renamed/references/recipes.md"]).toContain("{{applicant}}");

    // 🗑 Delete: two-click confirm removes the LOCAL entry only.
    const delRow = pop.locator(".recipe-lib-row", { hasText: "Filing renamed" });
    // Title persists across the confirm-text change ("Sure? click again").
    const delBtn = delRow.locator("button[title*='Remove from']");
    await delBtn.click();
    await expect(delBtn).toContainText("Sure?");
    await delBtn.click();
    await expect(pop.locator(".recipe-lib-row", { hasText: "Filing renamed" })).toHaveCount(0, { timeout: 10_000 });
    await expect(h.panel.locator("#messages .msg-system", { hasText: "Removed" })).toContainText("Filing renamed");
    // The workspace file the import came from is still served — untouched.
    const stillThere = await fetch(`${E2E_BASE}/__recipes`).then((r) => r.json());
    expect(stillThere.files["/home/workspace/recipes/e2e-filing.json"]).toBeUndefined(); // never written by the extension
    // The delete re-render leaves the popup open — close it for the next test.
    await h.panel.locator("#query-input").press("Escape");
    await expect(pop).toHaveClass(/hidden/);
  });

  test("an invalid import renders the validator's errors inside the popup", async () => {
    await fetch(`${E2E_BASE}/__recipes`, { method: "DELETE" });
    await h.panel.locator("#recipe-lib-btn").click();
    const pop = h.panel.locator("#recipe-library");
    await expect(pop).not.toHaveClass(/hidden/);
    // The #52 fixture serves plain notes text at unknown paths → not JSON.
    await pop.locator(".recipe-lib-import input").fill("/home/workspace/recipes/not-json.json");
    await pop.locator(".recipe-lib-import button").click();
    await expect(pop.locator(".recipe-lib-error")).toContainText("not valid JSON", { timeout: 15_000 });
    // Escape closes the popup (one Esc closes every composer popup).
    await h.panel.locator("#query-input").press("Escape");
    await expect(pop).toHaveClass(/hidden/);
  });
});
