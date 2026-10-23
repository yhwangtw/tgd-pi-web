import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const SID = "aaaa1111-2222-3333-4444-555566667777";
const MAIN = `/?session=${SID}`;
const OWNED_TAGS = ["chiptest", "menutest", "filtertest"];

async function clearOwnedTags(request: APIRequestContext) {
  for (const tag of OWNED_TAGS) {
    const response = await request.delete("/api/sessions/tags", { data: { id: SID, tag } });
    expect(response.ok(), `clean up #${tag}`).toBe(true);
  }
}

async function openMain(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByTestId("composer-shell").locator("textarea")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("textbox", { name: "Search conversations", exact: true }).fill("專案架構分析");
  await expect(page.locator('[data-session-row="aaaa1111-2222-3333-4444-555566667777"]')).toBeVisible();
}

async function addTag(page: Page, tag: string) {
  await page.locator('[data-session-row="aaaa1111-2222-3333-4444-555566667777"]').click({ button: "right" });
  // Menu entries are role=menuitem, not button
  await page.getByRole("menuitem", { name: "Add tag" }).click();
  const input = page.locator("input[placeholder*='tag']");
  await input.waitFor();
  await input.fill(tag); // fill, not type — typing races the focus timeout
  const saved = page.waitForResponse(response => response.url().endsWith("/api/sessions/tags") && response.request().method() === "POST");
  await page.keyboard.press("Enter");
  expect((await saved).ok()).toBe(true);
}

// Fixtures are regenerated per run, but tags.json persists within one run —
// clean up only this suite's tags even when a UI assertion fails or retries.
test.describe("session tags", () => {
  test.beforeEach(async ({ request }) => { await clearOwnedTags(request); });
  test.afterEach(async ({ request }) => { await clearOwnedTags(request); });
  test("add → chip appears immediately with a remove control", async ({ page }) => {
    await openMain(page);
    await addTag(page, "chiptest");
    // The chip must appear on the session item without a reload (this used to
    // break: the client map was keyed two different ways at once).
    const chip = page.locator("[class*=tagChip]", { hasText: "#chiptest" }).first();
    await expect(chip).toBeVisible();
    const remove = chip.getByRole("button", { name: "Remove #chiptest" });
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(page.locator("[class*=tagChip]", { hasText: "#chiptest" })).toHaveCount(0);
  });

  test("context menu lists current tags and removes them", async ({ page }) => {
    await openMain(page);
    await addTag(page, "menutest");
    await expect(page.locator("[class*=tagChip]", { hasText: "#menutest" }).first()).toBeVisible();

    await page.locator('[data-session-row="aaaa1111-2222-3333-4444-555566667777"]').click({ button: "right" });
    const menu = page.getByRole("menu");
    const menuRemove = menu.getByRole("menuitem", { name: "Remove #menutest", exact: true });
    await expect(menuRemove).toBeVisible();
    await menuRemove.click();
    await page.keyboard.press("Escape");
    await expect(page.locator("[class*=tagChip]", { hasText: "#menutest" })).toHaveCount(0);
  });

  test("tag filter chips filter the session list", async ({ page }) => {
    await openMain(page);
    await addTag(page, "filtertest");
    // Exercise the tag filter independently of the search used to find the row.
    await page.getByRole("textbox", { name: "Search conversations", exact: true }).fill("");
    // Tags live in the explicit conversation-filter dialog so the session
    // list stays scannable instead of growing another persistent toolbar.
    await page.getByRole("button", { name: "Conversation filters" }).click();
    const filters = page.getByRole("dialog", { name: "Conversation filters" });
    const filterChip = filters.getByRole("button", { name: /filtertest/ });
    await expect(filterChip).toBeVisible();
    await filterChip.click();
    await filters.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByText("專案架構分析").first()).toBeVisible();
    await expect(page.getByText("失敗的執行")).toHaveCount(0);
    // Clear the filter, clean up via the item chip
    await page.getByRole("button", { name: "Conversation filters" }).click();
    const reopenedFilters = page.getByRole("dialog", { name: "Conversation filters" });
    await reopenedFilters.getByRole("button", { name: /filtertest/ }).click();
    await reopenedFilters.getByRole("button", { name: "Done", exact: true }).click();
    // A cleared filter restores the full virtualized list, where this older
    // fixture may be outside the rendered window. Search brings it into view.
    const search = page.getByRole("textbox", { name: "Search conversations", exact: true });
    await search.fill("失敗的執行");
    await expect(page.getByText("失敗的執行").first()).toBeVisible();
    await search.fill("專案架構分析");
    const remove = page.locator("[class*=tagChip]", { hasText: "#filtertest" }).first()
      .getByRole("button", { name: "Remove #filtertest" });
    await remove.click();
    await expect(page.locator("[class*=tagChip]", { hasText: "#filtertest" })).toHaveCount(0);
  });
});
