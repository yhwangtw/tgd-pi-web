import { test, expect } from "@playwright/test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

for (const outcome of ["complete", "cancel"] as const) {
  test(`real SDK compaction retry ${outcome}: restores progress and keeps history`, async ({ page, request }) => {
    await page.setViewportSize({ width: outcome === "complete" ? 390 : 1440, height: 950 });
    await page.addInitScript(() => {
      localStorage.setItem("pi-locale", "en");
      localStorage.setItem("pi-theme", "dark");
      localStorage.setItem("pi-composer-hints", "off");
    });
    await page.route(/\/api\/agent\/[^/]+\/summarize$/, route => route.fulfill({ json: { skipped: true } }));
    const cwd = join(process.env.E2E_PROJECT_CWD!, `compact-progress-${outcome}`);
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    copyFileSync(join(process.env.E2E_PROJECT_CWD!, ".pi", "extensions", "reconnect-fixture.js"), join(cwd, ".pi", "extensions", "reconnect-fixture.js"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
      compaction: { enabled: false, keepRecentTokens: 1 },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 6000 },
    }));
    const created = await request.post("/api/agent/new", { data: { cwd, deferPrompt: true, provider: "e2e-reconnect-fixture", modelId: "deterministic" } });
    expect(created.ok(), await created.text()).toBe(true);
    const { sessionId } = await created.json();
    const url = `/?session=${sessionId}`;
    const compactPosts: unknown[] = [];
    page.on("request", req => {
      if (req.method() === "POST" && new URL(req.url()).pathname === `/api/agent/${sessionId}`) {
        const data = req.postDataJSON();
        if (data?.type === "compact") compactPosts.push(data);
      }
    });
    await page.goto(url);
    const log = page.getByRole("log", { name: "Conversation" });
    const input = page.getByRole("textbox", { name: "Message…", exact: true });
    for (const suffix of ["old", "recent"]) {
      const token = `progress-${outcome}-${suffix}`;
      await input.fill(`E2E_RECONNECT:complete:${token}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(log.getByText(`Fixture completed ${token}.`, { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    }
    await input.fill("/compact E2E_COMPACT_PROGRESS");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const status = page.getByTestId("compaction-status");
    const elapsed = page.getByTestId("compaction-elapsed");
    await expect(status).toContainText("Waiting to retry (1/1)");
    const before = await (await request.get(`/api/agent/${sessionId}`)).json();
    expect(before.state.compaction).toMatchObject({ status: "running", retry: { status: "waiting", attempt: 1, maxAttempts: 1 } });
    await page.reload();
    await expect(status).toContainText("Waiting to retry (1/1)");
    await expect(elapsed).not.toHaveText("· 0s", { timeout: 3000 });
    const resumed = await (await request.get(`/api/agent/${sessionId}`)).json();
    expect(resumed.state.compaction.id).toBe(before.state.compaction.id);
    expect(resumed.state.compaction.startedAt).toBe(before.state.compaction.startedAt);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    if (outcome === "cancel") {
      await status.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(status).toHaveAttribute("data-state", "cancelled");
      await expect(elapsed).toHaveCount(0);
      await expect(status).not.toContainText(/retry/i);
    } else {
      await expect(status).toContainText("Retrying (1/1)", { timeout: 10_000 });
      await page.screenshot({ path: test.info().outputPath("compact-real-sdk-retrying.png") });
      await expect.poll(async () => (await (await request.get(`/api/agent/${sessionId}`)).json()).state.compaction).toMatchObject({ status: "completed" });
      await expect(status).toHaveAttribute("data-state", "completed");
      const note = log.getByRole("note", { name: "Earlier context summary" });
      await expect(note).toHaveCount(1);
      await note.locator("summary").click();
      await expect(note).toContainText("Offline summary completed after 2 provider attempts.");
      await expect(note).toContainText("Offline turn-prefix summary.");
      await expect(elapsed).toHaveCount(0);
    }
    const final = await (await request.get(`/api/agent/${sessionId}`)).json();
    expect(final.state.isCompacting).toBe(false);
    expect(final.state.compaction.status).toBe(outcome === "cancel" ? "cancelled" : "completed");
    expect(final.state.compaction.retry).toBeUndefined();
    const persisted = await (await request.get(`/api/sessions/${sessionId}`)).json();
    expect(persisted.context.messages.filter((m: { role: string }) => m.role === "user")).toHaveLength(2);
    expect(persisted.context.messages.filter((m: { role: string; customType?: string }) => m.role === "custom" && m.customType === "pi-web-compaction")).toHaveLength(outcome === "cancel" ? 0 : 1);
    expect(compactPosts).toHaveLength(1);
  });
}
