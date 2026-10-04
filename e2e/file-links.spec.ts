import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// The ffff… fixture's assistant message contains `src/index.ts` as inline
// code, and that file exists in the demo project.
const TOOLS = "/?session=ffff1111-2222-3333-4444-555566667777";

test.describe("file-path links in chat", () => {
  test("parallel chat links resolve against their own project", async ({ page }) => {
    const parallelCwd = path.join(process.env.E2E_PROJECT_CWD!, "parallel-project");
    await mkdir(path.join(parallelCwd, "src"), { recursive: true });
    await writeFile(path.join(parallelCwd, "src/index.ts"), 'export const parallel_project_only = true;\n');
    await page.route(/\/api\/sessions(?:\?|$)/, async route => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, sessions: data.sessions.map((session: { id: string; cwd: string }) => session.id === "ffff1111-2222-3333-4444-555566667777" ? { ...session, cwd: parallelCwd } : session) } });
    });
    await page.goto("/?session=aaaa1111-2222-3333-4444-555566667777");
    await page.getByRole("option", { name: "工具呼叫測試", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in parallel", exact: true }).click();
    const parallel = page.locator('[data-chat-session-id="ffff1111-2222-3333-4444-555566667777"]');
    await expect(parallel).toHaveAttribute("data-chat-cwd", parallelCwd);
    await parallel.getByRole("link", { name: "查看程式", exact: true }).click();
    await expect(page.locator(".right-panel-container")).toContainText("parallel_project_only");
  });
  test("Markdown links open source lines and Unicode HTML previews in the right panel", async ({ page }) => {
    await page.goto(TOOLS);
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
    const sourceLink = page.getByRole("link", { name: "查看程式", exact: true });
    await sourceLink.click();
    await expect(page.getByText("export const answer").first()).toBeVisible();
    await expect(page).toHaveURL(/session=ffff1111/);
    const previewLink = page.getByRole("link", { name: "查看成果", exact: true });
    await previewLink.click();
    await expect(page.frameLocator('iframe[title="HTML preview"]').getByRole("heading", { name: "Linked HTML preview" })).toBeVisible();
    await expect(page).toHaveURL(/session=ffff1111/);
  });
  test("HTML bundles local assets, updates after edits, and recovers from a failed preview", async ({ page }) => {
    const cwd = process.env.E2E_PROJECT_CWD!;
    const file = path.join(cwd, "成果 預覽.html");
    const original = await readFile(file, "utf8");
    const html = '<h1>Live preview</h1><link rel="stylesheet" href="preview.css"><img alt="local drawing" src="preview.svg"><script src="preview.js"></script><script type="module" src="preview-module.js"></script>';
    await writeFile(path.join(cwd, "preview.css"), "h1 { color: rgb(20, 90, 160); }");
    await writeFile(path.join(cwd, "preview.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="blue"/></svg>');
    await writeFile(path.join(cwd, "preview.js"), 'document.body.dataset.classic="loaded";');
    await writeFile(path.join(cwd, "preview-module.js"), 'import { label } from "./preview-value.js"; document.body.dataset.module=label;');
    await writeFile(path.join(cwd, "preview-value.js"), 'export const label="module loaded";');
    await writeFile(file, html);
    try {
      let fail = true;
      await page.route("**/api/files/**?type=html-preview", async route => {
        if (fail) { await route.fulfill({ status: 503, contentType: "application/json", body: '{}' }); return; }
        await route.continue();
      });
      await page.goto(TOOLS);
      await page.getByRole("link", { name: "查看成果", exact: true }).click();
      await expect(page.locator(".right-panel-container").getByRole("alert")).toContainText("Preview could not load");
      fail = false;
      await page.getByRole("button", { name: "Retry preview" }).click();
      const frame = page.frameLocator('iframe[title="HTML preview"]');
      await expect(frame.getByRole("heading", { name: "Live preview" })).toHaveCSS("color", "rgb(20, 90, 160)");
      await expect(frame.locator("body")).toHaveAttribute("data-classic", "loaded");
      await expect(frame.locator("body")).toHaveAttribute("data-module", "module loaded");
      await expect.poll(() => frame.getByAltText("local drawing").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(12);
      await writeFile(file, html.replace("Live preview", "Updated live preview"));
      await expect(frame.getByRole("heading", { name: "Updated live preview" })).toBeVisible({ timeout: 10000 });
      await writeFile(path.join(cwd, "preview.css"), "h1 { color: rgb(160, 90, 20); }");
      await page.getByRole("button", { name: "Reload preview" }).click();
      await expect(frame.getByRole("heading")).toHaveCSS("color", "rgb(160, 90, 20)");
    } finally { await writeFile(file, original); }
  });
  test("clicking a file-path inline code opens it in the viewer", async ({ page }) => {
    await page.goto(TOOLS);
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByText("工具呼叫測試").first()).toBeVisible({ timeout: 20_000 });

    const link = page.locator('code[role="link"]', { hasText: "src/index.ts" }).first();
    await expect(link).toBeVisible();
    await link.click();

    // Right panel opens the file: tab label + real file content
    await expect(page.getByText("export const answer").first()).toBeVisible({ timeout: 10_000 });
  });

  test("non-path inline code is not clickable", async ({ page }) => {
    await page.goto(TOOLS);
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByText("工具呼叫測試").first()).toBeVisible({ timeout: 20_000 });

    // `answer` (final assistant message) is inline code but not a file path
    const plain = page.locator("code", { hasText: /^answer$/ }).first();
    await expect(plain).toBeVisible();
    await expect(plain).not.toHaveAttribute("role", "link");
  });
});
