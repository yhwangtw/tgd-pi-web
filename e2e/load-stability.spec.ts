import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

const SESSION = "ffff1111-2222-3333-4444-555566667777";

test("three live conversations with file previews leave HTTP/1 slots free for normal requests", async ({ browser, request, baseURL }) => {
  const activation = await request.post(`/api/agent/${SESSION}`, { data: { type: "get_state" } });
  expect(activation.ok()).toBe(true);
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-ui-style", "trae"); });
  const stages: Array<{ tabs: number; readyMs: number; probe: { ok: boolean; elapsedMs: number } }> = [];
  const fileStreams: string[] = [];
  try {
    for (let index = 0; index < 3; index++) {
      const page = await context.newPage();
      page.on("request", (request) => {
        if (request.resourceType() === "eventsource" && request.url().includes("type=watch")) fileStreams.push(request.url());
      });
      const start = performance.now();
      await page.goto(`/?session=${SESSION}`);
      await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "查看程式", exact: true }).click();
      const panel = page.getByRole("tabpanel", { name: "index.ts", exact: true });
      await expect(panel).toBeVisible();
      const probe = await page.evaluate(async () => {
        const start = performance.now();
        const response = await fetch("/api/runtime/identity", { cache: "no-store", signal: AbortSignal.timeout(3_000) });
        return { ok: response.ok, elapsedMs: performance.now() - start };
      });
      stages.push({ tabs: index + 1, readyMs: performance.now() - start, probe });
      expect(probe.ok).toBe(true);
    }
    expect(fileStreams).toEqual([]);
    await test.info().attach("multiple-tab-loading", { body: JSON.stringify({ stages, fileStreams }), contentType: "application/json" });
  } finally { await context.close(); }
});

test("metadata monitoring follows equal-size edits and reconciles a hidden file panel", async ({ page }) => {
  const cwd = process.env.E2E_PROJECT_CWD;
  if (!cwd) throw new Error("Generated fixture workspace required");
  const target = join(cwd, "src", "index.ts");
  const original = readFileSync(target, "utf8");
  const stat = statSync(target);
  const changed = original.replace(/\b\d+\b/, value => value.slice(0, -1) + ((Number(value.at(-1)) + 1) % 10));
  expect(changed).not.toBe(original);
  expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
  await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  try {
    await page.goto(`/?session=${SESSION}`);
    await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "查看程式", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "index.ts", exact: true });
    await expect(panel).toBeVisible();
    const meta = `/api/files/${target.split("/").filter(Boolean).map(encodeURIComponent).join("/")}?type=meta`;
    const revision = await page.request.get(meta).then(response => response.json()).then(data => data.revision);
    writeFileSync(target, changed);
    utimesSync(target, stat.atime, stat.mtime); // Timestamp/size alone must not hide an edit.
    await expect.poll(async () => page.request.get(meta).then(response => response.json()).then(data => data.revision)).not.toBe(revision);
    await expect(panel.locator("pre").first()).toContainText(changed.trim(), { timeout: 4_000 });
    await page.getByRole("button", { name: /^(Hide file panel|Back to chat)$/ }).click();
    writeFileSync(target, original);
    await page.getByRole("button", { name: "Show file panel", exact: true }).click();
    await expect(panel.locator("pre").first()).toContainText(original.trim(), { timeout: 4_000 });
  } finally { writeFileSync(target, original); utimesSync(target, stat.atime, stat.mtime); }
});
