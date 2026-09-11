import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

for (const style of ["original", "trae"]) {
  test(`diff identity, distant hunk navigation and stale-write protection (${style})`, async ({ page, request }) => {
    await page.addInitScript((value) => localStorage.setItem("pi-ui-style", value), style);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(MAIN);
    await expect(page.getByText("專案架構分析").first()).toBeVisible();
    await page.getByRole("button", { name: /^(Explorer|Files)$/ }).first().click();
    await page.getByRole("treeitem", { name: "README.md" }).click();
    await expect(page.getByTestId("right-panel-tab-bar")).toContainText("README.md");
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByText("diff-navigation.txt", { exact: true }).click();
    const panel = page.locator('.right-panel-container.right-panel-open');
    await expect(panel.getByRole("button", { name: "Next hunk" })).toBeVisible();
    await expect(page.getByTestId("right-panel-tab-bar")).toHaveCount(0);
    await expect(panel.locator('[data-diff-new-line="501"]')).toContainText("review change 501");

    // A same-numbered diff elsewhere must never capture right-panel navigation.
    await page.evaluate(() => {
      const decoy = document.createElement("div");
      decoy.dataset.diffNewLine = "1498";
      decoy.id = "diff-navigation-decoy";
      decoy.textContent = "Other diff";
      document.body.prepend(decoy);
    });
    for (let i = 0; i < 12; i++) await panel.getByRole("button", { name: "Next hunk" }).click();
    const target = panel.locator('[data-diff-new-line="12501"]');
    await expect(target).toContainText("review change 12501");
    await expect(target).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`diff-${style}.png`) });

    const path = join(process.env.E2E_PROJECT_CWD!, "diff-navigation.txt");
    const previous = await readFile(path, "utf8");
    try {
      await writeFile(path, previous + "external edit after opening the review\n");
      page.once("dialog", dialog => dialog.accept());
      await panel.getByRole("button", { name: "Revert hunk", exact: true }).click();
      await expect(panel.getByRole("alert")).toContainText("File changed");
      expect(await readFile(path, "utf8")).toBe(previous + "external edit after opening the review\n");
      await panel.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(panel.getByRole("button", { name: "Revert hunk", exact: true })).toBeVisible();
      const snapshot = await (await request.get(`/api/git/file-diff?cwd=${encodeURIComponent(process.env.E2E_PROJECT_CWD!)}&path=diff-navigation.txt`)).json();
      expect(snapshot.newText).toContain("external edit after opening the review");
    } finally { await writeFile(path, previous); }
  });
}
