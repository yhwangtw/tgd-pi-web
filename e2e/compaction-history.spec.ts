import { test, expect } from "@playwright/test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

for (const width of [390, 1440]) {
  test(`${width}px: real SDK compaction preserves history across reload and further replies`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.addInitScript(() => { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-composer-hints", "off"); });
    await page.route(/\/api\/agent\/[^/]+\/summarize$/, route => route.fulfill({ json: { skipped: true } }));
    const cwd = join(process.env.E2E_PROJECT_CWD!, `history-${width}`);
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    copyFileSync(join(process.env.E2E_PROJECT_CWD!, ".pi", "extensions", "reconnect-fixture.js"), join(cwd, ".pi", "extensions", "reconnect-fixture.js"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1 } }));
    const created = await request.post("/api/agent/new", { data: { cwd, deferPrompt: true, provider: "e2e-reconnect-fixture", modelId: "deterministic" } });
    expect(created.ok(), await created.text()).toBe(true);
    const { sessionId } = await created.json();
    const url = `/?session=${sessionId}`;
    await page.goto(url);
    const log = page.getByRole("log", { name: "Conversation" });
    const input = page.getByRole("textbox", { name: "Message…", exact: true });
    const send = async (token: string) => {
      await input.fill(`E2E_RECONNECT:complete:${token}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(log.getByText(`Fixture completed ${token}.`, { exact: false })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    };
    const oldToken = `history-old-${width}`;
    await send(oldToken); await send(`history-recent-${width}`);
    const before = await (await request.get(`/api/sessions/${sessionId}`)).json();
    const originalIds = before.context.entryIds;
    // Runs real SDK compaction through the UI. Only the summary generation is
    // supplied by an offline extension; no response or history API is mocked.
    await input.fill("/compact E2E_HISTORY_COMPACT");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const note = log.getByRole("note", { name: "Earlier context summary" });
    await expect(note).toHaveCount(1, { timeout: 20_000 });
    await expect(note.locator("details")).not.toHaveAttribute("open");
    await note.scrollIntoViewIfNeeded(); await note.locator("summary").click();
    await expect(note).toContainText("Earlier fixture decisions.");
    await note.locator("summary").click();
    const after = await (await request.get(`/api/sessions/${sessionId}`)).json();
    expect(after.context.entryIds.slice(0, originalIds.length)).toEqual(originalIds);
    expect(after.context.messages.filter((m: { role: string }) => m.role === "user")).toHaveLength(2);
    expect(after.context.messages.at(-1)).toMatchObject({ role: "custom", customType: "pi-web-compaction" });
    const originalDisk = readFileSync(after.filePath, "utf8");
    await page.reload(); await expect(note).toHaveCount(1);
    const oldQuestion = log.getByText(`E2E_RECONNECT:complete:${oldToken}`, { exact: true });
    await oldQuestion.scrollIntoViewIfNeeded(); await expect(oldQuestion).toBeVisible();
    expect(readFileSync(after.filePath, "utf8")).toBe(originalDisk);
    // The provider itself rejects this request if old messages have been
    // reintroduced into model context, while those messages remain in the UI.
    await send(`history-after-${width}`);
    await input.fill("/compact E2E_HISTORY_COMPACT");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(note).toHaveCount(2);
    await page.goto("/"); await page.goto(url);
    await expect(note).toHaveCount(2);
    await oldQuestion.scrollIntoViewIfNeeded(); await expect(oldQuestion).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const persisted = await (await request.get(`/api/sessions/${sessionId}`)).json();
    expect(persisted.context.messages.filter((m: { role: string }) => m.role === "user")).toHaveLength(3);
    expect(new Set(persisted.context.entryIds).size).toBe(persisted.context.entryIds.length);
    await page.screenshot({ path: test.info().outputPath(`compaction-history-${width}.png`) });
    writeFileSync(test.info().outputPath("compaction-history-session.json"), JSON.stringify({ sessionId, agentDir: join(process.env.E2E_ROOT!, "agent"), width }));
  });
}
