import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
test.beforeAll(() => {
  const root = path.join(process.env.E2E_PROJECT_CWD!, "search-scope-fixture");
  const file = (name: string, text = "scopeprobe content\n") => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  };
  file(".gitignore", "*.log\n.worktrees/\n");
  file("scopeprobe.ts");
  file("scopeprobe.log");
  file(".hidden/scopeprobe.ts");
  file(".worktrees/old/.git", "gitdir: /not-followed\n");
  file(".worktrees/old/scopeprobe.ts");
});

for (const style of ["original", "trae"]) {
  test(`${style}: file scope and saved views at mobile XL`, async ({ page }) => {
    await page.addInitScript(style => {
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-skin", "trae");
      localStorage.setItem("pi-font-size", "xlarge");
    }, style);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(MAIN);
    await expect(page.getByText("專案架構分析").first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-font-size", "xlarge");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const search = page.getByTestId("unified-search");
    await search.getByRole("textbox", { name: "Unified search" }).fill("scopeprobe");
    await search.getByRole("button", { name: "Files", exact: true }).click();
    const hits = search.locator("[data-search-result]");
    await expect(hits).toHaveCount(1);
    const trigger = search.getByRole("button", { name: /^File scope/ });
    await trigger.focus(); await trigger.press("Enter");
    const dialog = page.getByRole("dialog", { name: "File scope", exact: true });
    await expect(dialog).toContainText(process.env.E2E_PROJECT_CWD!);
    for (const checkbox of await dialog.getByRole("checkbox").all()) {
      await checkbox.focus(); await checkbox.press("Space");
      await expect(checkbox).toBeChecked();
    }
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      for (const checkbox of await dialog.getByRole("checkbox").all()) {
        await expect(checkbox).toBeVisible();
        expect(await checkbox.evaluate(el => el.closest("label")!.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: test.info().outputPath(`scope-${style}-${width}.png`) });
    }
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(hits).toHaveCount(4);
    await expect(search.getByRole("button", { name: "Conversation filters" })).toHaveCount(0);
    await expect.poll(() => search.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await search.getByRole("button", { name: "Save view", exact: true }).click();
    const save = page.getByRole("dialog", { name: "Save this search view" });
    await save.getByRole("textbox").fill("Scope fixture");
    await save.getByRole("button", { name: "Save view", exact: true }).click();
    await expect(save).toHaveCount(0);
    await trigger.click();
    await dialog.getByRole("button", { name: "Reset scope", exact: true }).click();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(hits).toHaveCount(1);
    await search.getByRole("button", { name: "Scope fixture", exact: true }).click();
    await expect(hits).toHaveCount(4);
    await trigger.click();
    for (const checkbox of await dialog.getByRole("checkbox").all()) await expect(checkbox).toBeChecked();
    await dialog.press("Escape");
    await expect(dialog).toHaveCount(0);
    await search.getByRole("button", { name: "Content", exact: true }).click();
    await expect(hits).toHaveCount(4);
    await page.screenshot({ path: test.info().outputPath(`results-${style}-320.png`) });
    await search.getByRole("button", { name: "All", exact: true }).click();
    await search.getByRole("button", { name: "Conversation filters" }).click();
    const conversations = page.getByRole("dialog", { name: "Conversation filters" });
    await expect(conversations).toContainText("do not change file or content results");
    await conversations.getByRole("button", { name: "Done", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await search.getByRole("button", { name: "Files", exact: true }).click();
    await hits.filter({ hasText: "search-scope-fixture/scopeprobe.ts" }).click();
    await expect(page.getByText("scopeprobe content", { exact: false }).last()).toBeVisible();
  });
}

test("filename and content APIs have identical opt-in paths", async ({ request }) => {
  for (const options of ["", "&hidden=1&ignored=1&worktrees=1"]) {
    const params = `cwd=${encodeURIComponent(process.env.E2E_PROJECT_CWD!)}&q=scopeprobe${options}`;
    const names = await request.get(`/api/files/search?${params}`);
    const content = await request.get(`/api/files/grep?${params}`);
    expect(names.ok()).toBe(true); expect(content.ok()).toBe(true);
    const filenameData = await names.json(); const contentData = await content.json();
    expect(contentData.matches.map((hit: { full: string }) => hit.full).sort()).toEqual(filenameData.results.map((hit: { full: string }) => hit.full).sort());
    expect(filenameData.results).toHaveLength(options ? 4 : 1);
  }
  expect((await request.get("/api/files/search?cwd=/&q=scopeprobe")).status()).toBe(403);
});
