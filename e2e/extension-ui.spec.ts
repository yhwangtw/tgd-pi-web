import { test, expect, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

async function openMain(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
}

test.describe("extension interactive UI", () => {
  test("round-trips Pi dialogs, effects, and editor text through the live session", async ({ page }) => {
    await openMain(page);
    const composer = page.locator("textarea").last();
    await composer.fill("/e2e-ui");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Choose a release target" })).toBeVisible();
    await expect(page.getByText("Waiting for decisions")).toBeVisible();
    await page.getByRole("button", { name: "Production", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Confirm release" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();

    const owner = page.getByRole("textbox", { name: "Release owner" });
    await expect(owner).toBeVisible();
    await owner.fill("QA Owner");
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    const notes = page.getByRole("textbox", { name: "Release notes" });
    await expect(notes).toHaveValue("Validated in the web UI.");
    await notes.fill("Browser verified.");
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expect(page.getByText("Complete", { exact: true })).toBeVisible();
    await expect(page.getByText("Production · QA Owner", { exact: true })).toBeVisible();
    await expect(page.getByText("Saved 1 line(s) for QA Owner", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("Release production when ready.");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
