import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const existing = "aaaa1111-2222-3333-4444-555566667777";
const createdSessionFiles: string[] = [];
test.afterEach(() => {
  for (const path of createdSessionFiles.splice(0)) unlinkSync(path);
});
for (const width of [1440, 390]) {
  test(`${width}: external conversations and unread replies appear without reloading`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem("pi-locale", "en");
      localStorage.setItem("pi-session-scope", "all");
    });
    await page.goto(`/?session=${existing}`);
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
    const openSidebar = async () => {
      if (width < 700 && !await page.getByRole("grid", { name: "Sessions" }).isVisible()) {
        await page.locator('nav[class*="mobileNav"]').getByRole("button", { name: "Sessions", exact: true }).click();
      }
    };
    await openSidebar();
    const id = randomUUID(); const cwd = process.env.E2E_PROJECT_CWD!;
    const dir = join(process.env.PI_E2E_RUN_ROOT!, "agent", "sessions", "--live-sidebar--");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`); const timestamp = Date.now();
    const message = (entry: string, parentId: string, time: number, text: string) => ({ type: "message", id: entry, parentId, timestamp: new Date(time).toISOString(), message: { role: "assistant", content: [{ type: "text", text }], timestamp: time, model: "fixture", provider: "fixture", stopReason: "stop" } });
    const rows = [
      { type: "session", version: 3, id, cwd, timestamp: new Date(timestamp).toISOString() },
      { type: "session_info", id: "name", parentId: null, name: `New external conversation ${width}`, timestamp: new Date(timestamp).toISOString() },
      { type: "message", id: "question", parentId: "name", timestamp: new Date(timestamp).toISOString(), message: { role: "user", content: "Check live sidebar", timestamp } },
      message("answer", "question", timestamp + 1, "New external reply"),
    ];
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    createdSessionFiles.push(path);
    const row = page.locator(`[data-session-row="${id}"]`);
    await expect(row).toBeVisible({ timeout: 12_000 });
    await expect(row).toHaveAttribute("data-unread", "true");
    await expect(row).toHaveAccessibleDescription("Unread messages");
    await row.screenshot({ path: info.outputPath(`unread-${width}.png`) });
    await row.click();
    await expect(page.getByText("New external reply", { exact: true }).last()).toBeVisible();
    await openSidebar();
    await expect(row).not.toHaveAttribute("data-unread", "true");
    // Move away before another writer adds a reply.
    await page.locator(`[data-session-row="${existing}"]`).click();
    appendFileSync(path, JSON.stringify(message("later", "answer", timestamp + 10_000, "Later unseen reply")) + "\n");
    await openSidebar();
    await expect(row).toHaveAttribute("data-unread", "true", { timeout: 12_000 });
    await row.click();
    await expect(page.getByText("Later unseen reply", { exact: true }).last()).toBeVisible();
    await openSidebar();
    await expect(row).not.toHaveAttribute("data-unread", "true");
    await page.reload();
    await openSidebar();
    await expect(row).not.toHaveAttribute("data-unread", "true");
  });
}
