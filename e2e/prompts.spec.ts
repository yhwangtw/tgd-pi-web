import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

// A name that is NOT a substring of any /tgd-* command, so the slash filter
// selects the template unambiguously.
const NAME = "qacheck";
const BODY = "Run the full QA checklist and report anything red.";

async function openMain(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
}

// prompts.json persists for the whole run — clean this name via the API so the
// spec is idempotent regardless of order or reruns.
async function deleteByName(request: APIRequestContext, name: string) {
  const res = await request.get("/api/prompts");
  if (!res.ok()) return;
  const { prompts = [] } = await res.json() as { prompts?: { id: string; name: string }[] };
  for (const p of prompts.filter((x) => x.name === name)) {
    await request.delete("/api/prompts", { data: { id: p.id } });
  }
}

test.describe("prompt templates", () => {
  test.beforeEach(async ({ request }) => { await deleteByName(request, NAME); });
  test.afterEach(async ({ request }) => { await deleteByName(request, NAME); });

  test("create in the modal → appears in the / menu → inserts its body", async ({ page }) => {
    await openMain(page);

    // Open the manager via the command palette
    await page.keyboard.press("Control+k");
    const search = page.getByRole("textbox", { name: "Unified search" });
    await expect(search).toBeFocused();
    await search.fill("prompt templates");
    await page.getByRole("button", { name: /^Prompt templates / }).click();

    // Add a template
    const dialog = page.getByRole("dialog", { name: "Prompt templates" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Template name" }).fill(NAME);
    await dialog.getByRole("textbox", { name: "Template body" }).fill(BODY);
    await page.getByRole("button", { name: "Add template" }).click();
    // Saved item shows in the list with a Delete control (unambiguous — the
    // live name-hint also renders the /name text while typing).
    await expect(page.getByRole("button", { name: "Delete" }).first()).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Template name" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // It shows up in the composer's slash menu and inserts the BODY (not /name)
    const composer = page.getByTestId("composer-shell").locator("textarea");
    await composer.click();
    await composer.type(`/${NAME}`);
    await expect(page.getByText("template", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(async () => composer.inputValue()).toContain(BODY);
  });
});
