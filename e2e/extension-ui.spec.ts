import { test, expect, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

async function openMain(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
}

for (const style of ["original", "trae"] as const) {
  for (const width of [1440, 390, 320]) {
  test(`${style} ${width}px: all Pi questions are inline and round-trip through the live session`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(style => {
      localStorage.setItem("pi-locale", "en");
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-skin", style === "trae" ? "trae" : "default");
    }, style);
    await openMain(page);
    const inertBefore = await page.locator("[inert]").count();
    const composer = page.getByTestId("composer-shell").locator("textarea");
    const responses: unknown[] = [];
    page.on("request", request => {
      if (request.method() !== "POST" || !request.url().includes("/api/agent/")) return;
      const body = request.postDataJSON();
      if (body?.type === "extension_ui_response") responses.push(body);
    });
    await composer.fill("/e2e-ui");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const card = page.getByTestId("inline-user-question");
    async function reveal(title: string) {
      await expect(card.getByRole("heading", { name: title, exact: true })).toBeAttached();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator("[inert]")).toHaveCount(inertBefore);
      await expect(composer).toBeVisible();
      expect(await card.evaluate(element => Boolean(element.closest("[data-transcript-scroll]")))).toBe(true);
      await page.getByRole("button", { name: "View question", exact: true }).click();
      await expect(card.getByRole("heading", { name: title, exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await reveal("Choose a release target");
    await expect(page.getByText("Waiting for decisions")).toBeVisible();
    await page.getByRole("radio", { name: "Production", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await reveal("Confirm release");
    await card.getByRole("button", { name: "Answer later", exact: true }).click();
    await composer.fill("My unsent draft while the agent waits.");
    await page.keyboard.press("Escape");
    expect(responses).toHaveLength(1); // Selecting a target only; deferral never confirms.
    await reveal("Confirm release");
    await expect(composer).toHaveValue("My unsent draft while the agent waits.");
    await page.screenshot({ path: testInfo.outputPath("inline-confirmation.png") });
    await page.getByRole("button", { name: "Confirm", exact: true }).click();

    await reveal("Release owner");
    const owner = page.getByRole("textbox", { name: "Release owner" });
    await expect(owner).toBeVisible();
    await owner.fill("QA Owner");
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await reveal("Release notes");
    const notes = page.getByRole("textbox", { name: "Release notes" });
    await expect(notes).toHaveValue("Validated in the web UI.");
    await notes.fill("Browser verified.");
    await card.getByRole("button", { name: "Answer later", exact: true }).click();
    await reveal("Release notes");
    await expect(notes).toHaveValue("Browser verified.");
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expect(page.getByText("Complete", { exact: true })).toBeVisible();
    await expect(page.getByText("Production · QA Owner", { exact: true })).toBeVisible();
    await expect(page.getByText("Saved 1 line(s) for QA Owner", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("Release production when ready.");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(responses).toHaveLength(4);
  });
  }
}
