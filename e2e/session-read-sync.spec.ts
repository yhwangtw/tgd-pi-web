import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const existing = "aaaa1111-2222-3333-4444-555566667777";
const paths: string[] = [];
test.afterEach(() => { for (const path of paths.splice(0)) unlinkSync(path); });
function conversation() {
  const id = randomUUID(); const timestamp = Date.now();
  const dir = join(process.env.PI_E2E_RUN_ROOT!, "agent", "sessions", "--read-sync--"); mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`); paths.push(path);
  writeFileSync(path, [
    { type: "session", version: 3, id, cwd: process.env.E2E_PROJECT_CWD!, timestamp: new Date(timestamp).toISOString() },
    { type: "message", id: "q", parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: "user", content: "Read sync question", timestamp } },
    { type: "message", id: "a", parentId: "q", timestamp: new Date(timestamp + 1).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `Read sync answer ${id}` }], model: "fixture", provider: "fixture", timestamp: timestamp + 1, stopReason: "stop" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  return id;
}

test("unobscured reads sync to a separate browser context without opening that conversation", async ({ page, browser, baseURL }) => {
  const id = conversation();
  await page.addInitScript(() => { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-composer-hints", "off"); });
  await page.goto(`/?session=${id}`); await page.bringToFront();
  await expect(page.getByTestId("assistant-message").getByText(`Read sync answer ${id}`, { exact: true })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/api/sessions")).json()).readState?.receipts[id]?.entryId).toBe("a");
  const observer = await browser.newContext({ baseURL });
  try {
    const other = await observer.newPage();
    await other.addInitScript(() => { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-session-scope", "all"); localStorage.setItem("pi-composer-hints", "off"); });
    await other.goto(`/?session=${existing}`);
    const row = other.locator(`[data-session-row="${id}"]`);
    await expect(row).toBeVisible(); await expect(row).not.toHaveAttribute("data-unread", "true");
    const snapshot = (await (await other.request.get("/api/sessions")).json()).readState;
    const refused = await other.request.post("/api/sessions/reads", { headers: { origin: baseURL! }, data: { scope: "different-backend", receipts: [{ id, entryId: "a" }] } });
    expect(refused.status()).toBe(409);
    expect((await (await other.request.get("/api/sessions")).json()).readState.receipts[id]).toEqual(snapshot.receipts[id]);
  } finally { await observer.close(); }
});

test("a visible modal prevents read marking until dismissed and the transcript has dwelled", async ({ page }) => {
  const id = conversation();
  await page.addInitScript(() => {
    localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-composer-hints", "off");
    document.addEventListener("DOMContentLoaded", () => {
      const dialog = document.createElement("div"); dialog.id = "read-test-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.textContent = "Read visibility fixture";
      dialog.style.cssText = "position:fixed;inset:0;z-index:99999;background:#222;color:white";
      document.body.append(dialog);
    });
  });
  await page.goto(`/?session=${id}`); await page.bringToFront();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(1200);
  expect((await (await page.request.get("/api/sessions")).json()).readState.receipts[id]).toBeUndefined();
  await page.locator("#read-test-modal").evaluate(element => element.remove());
  await expect.poll(async () => (await (await page.request.get("/api/sessions")).json()).readState.receipts[id]?.entryId).toBe("a");
});
