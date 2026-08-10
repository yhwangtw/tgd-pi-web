import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const MAIN_ID = "aaaa1111-2222-3333-4444-555566667777";
const ERROR_ID = "eeee1111-2222-3333-4444-555566667777";
const IMPORT_ID = "99991111-2222-3333-4444-555566667777";

function fixturePath(fileName: string): string {
  const root = process.env.E2E_ROOT;
  if (!root) throw new Error("E2E_ROOT is unavailable");
  return path.join(root, "agent", "sessions", "-demo", fileName);
}

function projectPath(fileName: string): string {
  const cwd = process.env.E2E_PROJECT_CWD;
  if (!cwd) throw new Error("E2E_PROJECT_CWD is unavailable");
  return path.join(cwd, fileName);
}

async function openSession(page: Page, sessionId: string, visibleText: string) {
  await page.goto(`/?session=${sessionId}`);
  await expect(page.getByText(visibleText).first()).toBeVisible({ timeout: 20_000 });
}

async function sendCommand(page: Page, command: string) {
  const composer = page.locator("textarea").last();
  await composer.fill(command);
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== "POST" || !/\/api\/agent\/[^/]+$/.test(new URL(response.url()).pathname)) return false;
    try {
      return (request.postDataJSON() as { type?: string }).type === "prompt";
    } catch {
      return false;
    }
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  return new URL(response.url()).pathname;
}

async function sessionId(page: Page): Promise<string | null> {
  return new URL(page.url()).searchParams.get("session");
}

test("AgentSessionRuntime replaces every connected tab, prevents conflicts, and imports safely", async ({ browser }) => {
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await Promise.all([
    openSession(tabA, MAIN_ID, "專案架構分析"),
    openSession(tabB, MAIN_ID, "專案架構分析"),
  ]);

  expect(await sendCommand(tabA, "/e2e-new")).toBe(`/api/agent/${MAIN_ID}`);
  await expect.poll(() => sessionId(tabA)).not.toBe(MAIN_ID);
  const newId = await sessionId(tabA);
  expect(newId).toBeTruthy();
  await expect.poll(() => sessionId(tabB)).toBe(newId);
  const liveStateResponse = await tabA.request.get(`/api/agent/${newId}`);
  expect(liveStateResponse.ok(), await liveStateResponse.text()).toBe(true);
  const liveState = await liveStateResponse.json() as { running?: boolean };
  const previousLiveState = await (await tabA.request.get(`/api/agent/${MAIN_ID}`)).json() as { running?: boolean };
  expect(liveState.running, JSON.stringify({ replacement: liveState, previous: previousLiveState })).toBe(true);
  expect(previousLiveState.running).toBe(false);
  await expect.poll(async () => (await tabA.request.get(`/api/sessions/${newId}`)).status()).toBe(200);
  const newSessionResponse = await tabA.request.get(`/api/sessions/${newId}`);
  expect(newSessionResponse.ok()).toBe(true);
  await expect(newSessionResponse.json()).resolves.toMatchObject({ info: { name: "Runtime new session" } });
  await expect(tabA.locator("textarea").last()).toBeEnabled();
  const newRuntimeReport = await (await tabA.request.get(`/api/agent/${newId}/extensions`)).json() as {
    commands?: Array<{ name: string }>;
  };
  expect(newRuntimeReport.commands?.map((command) => command.name)).toContain("e2e-switch");

  const mainFile = fixturePath("2026-07-01T10-00-00_aaaa1111-2222-3333-4444-555566667777.jsonl");
  expect(await sendCommand(tabA, `/e2e-switch ${JSON.stringify(mainFile)}`)).toBe(`/api/agent/${newId}`);
  await expect.poll(() => sessionId(tabA)).toBe(MAIN_ID);
  await expect.poll(() => sessionId(tabB)).toBe(MAIN_ID);
  const switchedRuntimeReport = await (await tabA.request.get(`/api/agent/${MAIN_ID}/extensions`)).json() as {
    runtime?: { state?: string; replacementCount?: number; lastReplacement?: { reason?: string } };
  };
  expect(switchedRuntimeReport.runtime).toMatchObject({
    state: "ready",
    replacementCount: 2,
    lastReplacement: { reason: "switch" },
  });

  await sendCommand(tabA, "/e2e-fork m1000007");
  await expect.poll(() => sessionId(tabA)).not.toBe(MAIN_ID);
  const forkId = await sessionId(tabA);
  expect(forkId).toBeTruthy();
  await expect.poll(() => sessionId(tabB)).toBe(forkId);
  await expect.poll(async () => (await tabA.request.get(`/api/sessions/${forkId}`)).status()).toBe(200);
  const forkSessionResponse = await tabA.request.get(`/api/sessions/${forkId}`);
  expect(forkSessionResponse.ok()).toBe(true);
  await expect(forkSessionResponse.json()).resolves.toMatchObject({ info: { messageCount: 6 } });

  const runtimeResponse = await tabA.request.get(`/api/agent/${forkId}/extensions`);
  expect(runtimeResponse.ok()).toBe(true);
  const runtimeReport = await runtimeResponse.json() as {
    compatibility: { commandContext: string };
    runtime: { state: string; replacementCount: number; lastReplacement?: { reason: string } };
  };
  expect(runtimeReport.compatibility.commandContext).toBe("supported");
  expect(runtimeReport.runtime).toMatchObject({
    state: "ready",
    replacementCount: 3,
    lastReplacement: { reason: "fork" },
  });

  const conflictTab = await context.newPage();
  await openSession(conflictTab, ERROR_ID, "失敗的執行");
  const conflictRuntimeResponse = await conflictTab.request.get(`/api/agent/${ERROR_ID}/extensions`);
  expect(conflictRuntimeResponse.ok()).toBe(true);
  await expect(conflictRuntimeResponse.json()).resolves.toMatchObject({
    runtime: { state: "ready", sessionId: ERROR_ID },
  });
  const errorFile = fixturePath("2026-07-04T10-00-00_eeee1111-2222-3333-4444-555566667777.jsonl");
  await sendCommand(tabA, `/e2e-switch ${JSON.stringify(errorFile)}`);
  await expect(tabA.getByText(/already active in another runtime/i)).toBeVisible();
  expect(await sessionId(tabA)).toBe(forkId);
  expect(await sessionId(conflictTab)).toBe(ERROR_ID);

  await tabA.keyboard.press("Meta+k");
  const search = tabA.getByRole("textbox", { name: "Unified search" });
  await search.fill("Import Pi Session");
  await tabA.getByRole("button", { name: /Import Pi Session/ }).click();

  const dialog = tabA.getByRole("dialog", { name: "Import Pi session" });
  await dialog.getByLabel("Session JSONL path").fill(projectPath("importable-session.jsonl"));
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByTestId("session-import-preview")).toContainText("Imported runtime session");
  await dialog.getByRole("button", { name: "Import session", exact: true }).click();

  await expect.poll(() => sessionId(tabA)).toBe(IMPORT_ID);
  await expect.poll(() => sessionId(tabB)).toBe(IMPORT_ID);
  await expect(tabA.getByText("Import preview and runtime replacement verified.")).toBeVisible();
  await context.close();
});
