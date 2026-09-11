import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

for (const style of ["original", "trae"]) {
  test(`${style}: conflicts keep the draft and require a reviewed revision`, async ({ page }) => {
    const filename = `edit-conflict-${style}.txt`;
    const file = path.join(process.env.E2E_PROJECT_CWD!, filename);
    await writeFile(file, "original file\n");
    await page.addInitScript(({ style }) => {
      if (window.top !== window) return;
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-font-size", "xlarge");
    }, { style });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(MAIN);
    await page.getByRole("button", { name: "Explorer", exact: true }).click();
    await page.getByRole("treeitem", { name: filename, exact: true }).click();
    const panel = page.locator(".right-panel-container.right-panel-open");
    await panel.getByRole("button", { name: "More file actions" }).click();
    await page.getByRole("menuitem", { name: "Edit file", exact: true }).click();
    const editor = panel.getByRole("textbox", { name: "File editor" });
    await editor.fill("my unsaved draft\n");
    await writeFile(file, "external version one\n");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    const review = panel.getByRole("region", { name: "Review disk vs draft" });
    await expect(review).toBeVisible();
    await expect(editor).toHaveValue("my unsaved draft\n");
    await expect(review).toContainText("external version one");
    expect(await readFile(file, "utf8")).toBe("external version one\n");

    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator("html")).toHaveAttribute("data-font-size", "xlarge");
      await expect(review.getByRole("button", { name: "Save this draft" })).toBeVisible();
      await expect.poll(() => review.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      for (const button of await review.getByRole("button").all()) {
        expect(await button.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: test.info().outputPath(`edit-conflict-${style}-${width}.png`) });
    }
    // The explicit retry is still version-checked, not a force-overwrite route.
    await writeFile(file, "external version two\n");
    await review.getByRole("button", { name: "Save this draft" }).click();
    await expect(review).toContainText("external version two");
    await expect(editor).toHaveValue("my unsaved draft\n");
    expect(await readFile(file, "utf8")).toBe("external version two\n");
    await editor.fill("manually reviewed merge\n");
    await review.getByRole("button", { name: "Save this draft" }).focus();
    await review.getByRole("button", { name: "Save this draft" }).press("Enter");
    await expect(editor).not.toBeVisible();
    expect(await readFile(file, "utf8")).toBe("manually reviewed merge\n");

    await panel.getByRole("button", { name: "More file actions" }).click();
    await page.getByRole("menuitem", { name: "Edit file", exact: true }).click();
    await editor.fill("discard this draft\n");
    await writeFile(file, "keep disk content\n");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await review.getByRole("button", { name: "Discard draft and use disk" }).click();
    await expect(editor).toHaveValue("keep disk content\n");
    await expect(review).not.toBeVisible();
    expect(await readFile(file, "utf8")).toBe("keep disk content\n");
  });
}
