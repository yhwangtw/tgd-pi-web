import { test, expect, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

async function openFiles(page: Page) {
  const explorerButton = page.getByRole("button", { name: /^(Explorer|Files)$/ }).first();
  await expect(explorerButton).toBeVisible();
  const openFilesPanel = page.locator('.sidebar-container.sidebar-open[data-panel-view="files"]');
  if (await openFilesPanel.count() === 0) await explorerButton.click();
  await expect(openFilesPanel).toBeAttached();
  await expect(page.getByText("README.md", { exact: true })).toBeVisible();
}

async function openReadme(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
  await openFiles(page);
  await page.getByRole("treeitem", { name: "README.md" }).click();
  await expect(page.locator(".right-panel-container.right-panel-open")).toBeVisible({ timeout: 10_000 });
}

test.describe("file viewer", () => {
  test("splitter drags the panel width, persists, and resets on double-click", async ({ page }) => {
    await openReadme(page);
    const panel = page.locator(".right-panel-container");
    // Wait for the open animation (width transition) to settle before measuring
    // the thin resize handle, or its box is a moving target and the drag misses.
    await expect
      .poll(async () => {
        const w = await panel.evaluate((el) => Math.round(el.getBoundingClientRect().width));
        await page.waitForTimeout(120);
        const w2 = await panel.evaluate((el) => Math.round(el.getBoundingClientRect().width));
        return w === w2 ? w : -1;
      })
      .toBeGreaterThan(0);
    const before = await panel.evaluate((el) => el.getBoundingClientRect().width);

    const resizer = page.locator(".right-panel-resizer");
    const box = (await resizer.boundingBox())!;
    // Distinct intermediate moves — a real drag emits many mousemove events,
    // and only a moved drag persists the width (see useRightPanelWidth).
    await page.mouse.move(box.x + 4, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x - 40, box.y + 300);
    await page.mouse.move(box.x - 110, box.y + 300);
    await page.mouse.move(box.x - 180, box.y + 300);
    await page.mouse.up();
    await expect
      .poll(() => panel.evaluate((el) => el.getBoundingClientRect().width))
      .toBeGreaterThan(before + 120);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("pi-right-width")))
      .toBeTruthy();

    await resizer.dblclick();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("pi-right-width")))
      .toBeNull();
  });

  test("in-file find highlights matches; :N jumps to a line", async ({ page }) => {
    await openReadme(page);
    // README opens in markdown preview — switch to the raw source view
    await page.getByRole("button", { name: "Raw", exact: true }).click();
    const find = page.locator("input[placeholder='find / :line']");
    await find.fill("Demo");
    await expect(page.locator("[data-active-line]").first()).toBeAttached();
    await find.fill(":3");
    await expect(page.locator("[data-active-line]").first()).toBeAttached();
  });

  test("large files fall back to plain rendering with working go-to-line", async ({ page }) => {
    await page.goto(MAIN);
    await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
    await openFiles(page);
    await page.getByText("big-file.ts").first().click();
    // Plain mode by default: toolbar badge present, zero Prism tokens
    await expect(page.getByText("large-file mode")).toBeVisible({ timeout: 15_000 });
    expect(await page.locator(".right-panel-container span[class*='token']").count()).toBe(0);
    // go-to-line still exact
    await page.locator("input[placeholder='find / :line']").fill(":1500");
    await expect(page.locator("[data-active-line]").first()).toBeVisible();
    await expect(page.locator("[data-active-line]").first()).toContainText("item1498");
  });

  test("keeps the HTML preview action inside a narrow right panel", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(MAIN);
    await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "tGD artifacts" }).click();
    await page.getByText("variant-a.html").click();

    const panel = page.locator(".right-panel-container.right-panel-open");
    const preview = page.getByRole("button", { name: "Preview", exact: true });
    await expect(panel).toBeVisible();
    await expect(preview).toBeVisible();

    const expectPreviewInsideView = async () => {
      await expect
        .poll(async () => {
          const width = await panel.evaluate((el) => Math.round(el.getBoundingClientRect().width));
          await page.waitForTimeout(120);
          const nextWidth = await panel.evaluate((el) => Math.round(el.getBoundingClientRect().width));
          return width === nextWidth ? width : -1;
        })
        .toBeGreaterThan(0);
      const panelBox = (await panel.boundingBox())!;
      const previewBox = (await preview.boundingBox())!;
      const viewportWidth = page.viewportSize()!.width;
      expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
      expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(viewportWidth);
    };

    await expectPreviewInsideView();
    await page.setViewportSize({ width: 1024, height: 800 });
    await expectPreviewInsideView();

    await preview.click();
    await expect(page.locator('iframe[title="HTML preview"]')).toBeVisible();
  });

  test("edit → save writes the file to disk", async ({ page }) => {
    await openReadme(page);
    await page.getByRole("button", { name: "Raw", exact: true }).click();
    await page.getByRole("button", { name: "More file actions" }).click();
    await page.getByRole("button", { name: "Edit file", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "File editor" });
    await expect(editor).toBeVisible();
    expect(await editor.inputValue()).toContain("Demo");

    await editor.fill("# Demo project\n\nsaved-from-viewer\n");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    const onDisk = await page.evaluate(async (cwd: string) => {
      const encoded = `${cwd}/README.md`.replace(/^\//, "");
      const res = await fetch(`/api/files/${encoded}?type=read`);
      const d = await res.json();
      return d.content as string;
    }, process.env.E2E_PROJECT_CWD!);
    expect(onDisk).toContain("saved-from-viewer");
  });

  test("opens an outline inspector and sends selected lines to the composer", async ({ page }) => {
    await openReadme(page);
    await page.getByRole("button", { name: "Inspector", exact: true }).click();
    const inspector = page.getByTestId("file-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("button", { name: /Demo project/ })).toBeVisible();
    await inspector.getByRole("button", { name: "Close inspector" }).click();

    await page.getByRole("button", { name: "Raw", exact: true }).click();
    await page.locator('[data-line-number="1"]').evaluate((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      line.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await expect(page.getByRole("toolbar", { name: /Selected lines 1 to 1/ })).toBeVisible();
    await page.getByRole("button", { name: "Add to prompt", exact: true }).click();
    await expect.poll(() => page.locator("textarea").last().inputValue()).toContain("README.md:1");
  });

  test("renders JSON trees, CSV tables, and binary hex previews", async ({ page }) => {
    await page.goto(MAIN);
    await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
    await openFiles(page);

    await page.getByRole("treeitem", { name: "data.json" }).click();
    await page.getByRole("button", { name: "Tree", exact: true }).click();
    await expect(page.getByTitle("Copy $.project")).toBeVisible();

    await openFiles(page);
    await page.getByRole("treeitem", { name: "table.csv" }).click();
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByPlaceholder("Filter rows…")).toBeVisible();
    await expect(page.getByRole("columnheader").filter({ hasText: "status" })).toBeVisible();

    await openFiles(page);
    await page.getByRole("treeitem", { name: "sample.bin" }).click();
    await expect(page.getByText(/00000000\s+50 69 00 57 65 62/)).toBeVisible();
  });

  test("persists open tabs and supports split view", async ({ page }) => {
    await openReadme(page);
    await page.getByRole("button", { name: "Explorer", exact: true }).click();
    await page.getByRole("treeitem", { name: "data.json" }).click();
    const readmeTab = page.locator('[class*="TabBar_tab"]').filter({ hasText: "README.md" }).first();
    await readmeTab.click({ button: "right" });
    await page.getByRole("button", { name: "Open in split", exact: true }).click();
    await expect(page.getByTestId("file-split-pane")).toBeVisible();

    await page.reload();
    await expect(page.locator('[class*="TabBar_tab"]').filter({ hasText: "README.md" }).first()).toBeVisible();
    await expect(page.locator('[class*="TabBar_tab"]').filter({ hasText: "data.json" }).first()).toBeVisible();
    await expect(page.getByTestId("file-split-pane")).toBeVisible();
  });

  test("shows hunk review controls for working-tree changes", async ({ page }) => {
    await page.goto(MAIN);
    await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByText("src/index.ts", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Revert hunk", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Keep", exact: true })).toBeVisible();
  });

  test("keeps the inspector and file actions usable on a phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openReadme(page);
    await page.getByRole("button", { name: "Inspector", exact: true }).click();
    const inspector = page.getByTestId("file-inspector");
    await expect(inspector).toBeVisible();
    const box = (await inspector.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    await inspector.getByRole("button", { name: "Close inspector" }).click();
    await page.getByRole("button", { name: "More file actions" }).click();
    await expect(page.getByRole("button", { name: "Focus mode", exact: true })).toBeVisible();
  });
});
