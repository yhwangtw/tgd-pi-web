import { test, expect } from "@playwright/test";
import { gzipSync } from "node:zlib";
import { javascriptBudget } from "../scripts/js-budget-policy.mjs";

// The build audit measures rendered script tags. This check independently
// measures scripts the browser fetches through hydration, including dynamic
// imports that are absent from the prerendered HTML. Deferred user actions are
// deliberately outside this hydrated-UI budget. Its separate policy must never
// change the HTML entry-script gate in audit-js-budget.mjs.
const limits = javascriptBudget("hydrated");
for (const route of ["/login", "/?session=aaaa1111-2222-3333-4444-555566667777"]) {
  test(`initial hydrated JavaScript budget: ${route}`, async ({ page }, testInfo) => {
    const pending = new Set<string>();
    const failed: string[] = [];
    const chunks = new Map<string, Promise<Buffer>>();
    const isScript = (url: string) => new URL(url).pathname.startsWith("/_next/static/") && new URL(url).pathname.endsWith(".js");
    page.on("request", request => { if (isScript(request.url())) pending.add(request.url()); });
    page.on("requestfailed", request => {
      if (isScript(request.url())) { pending.delete(request.url()); failed.push(new URL(request.url()).pathname); }
    });
    page.on("requestfinished", request => { pending.delete(request.url()); });
    page.on("response", response => {
      if (!isScript(response.url())) return;
      if (!response.ok()) failed.push(`${response.status()} ${new URL(response.url()).pathname}`);
      chunks.set(new URL(response.url()).pathname, response.body());
    });
    await page.goto(route);
    if (route === "/login") await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
    else await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => pending.size).toBe(0);
    const loaded = await Promise.all([...chunks].map(async ([path, body]) => {
      const bytes = await body;
      return { path, rawBytes: bytes.byteLength, gzipBytes: gzipSync(bytes, { level: 9 }).byteLength };
    }));
    const rawBytes = loaded.reduce((total, chunk) => total + chunk.rawBytes, 0);
    const gzipBytes = loaded.reduce((total, chunk) => total + chunk.gzipBytes, 0);
    await testInfo.attach("initial-javascript.json", { body: JSON.stringify({ scope: "hydrated", route, checkpoint: "initial fixture UI visible, two animation frames, tracked script requests complete", compression: "Node gzip level 9 per unique script body", limits, rawBytes, gzipBytes, chunks: loaded, failed }, null, 2), contentType: "application/json" });
    expect(failed).toEqual([]);
    expect(loaded.length).toBeGreaterThan(0);
    expect(rawBytes).toBeLessThanOrEqual(limits.rawBytes);
    expect(gzipBytes).toBeLessThanOrEqual(limits.gzipBytes);
  });
}
