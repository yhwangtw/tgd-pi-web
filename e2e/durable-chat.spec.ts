import { expect, test, type Page } from "@playwright/test";

const MAIN_ID = "aaaa1111-2222-3333-4444-555566667777";
const PROVIDER = "e2e-reconnect-fixture";
type TranscriptMessage = { role: string; content: unknown; toolName?: string; isError?: boolean };

function currentId(page: Page) { return new URL(page.url()).searchParams.get("session"); }
function fixtureCwd() {
  if (!process.env.E2E_ROOT || !process.env.E2E_PROJECT_CWD) throw new Error("Generated offline E2E fixtures are required");
  return process.env.E2E_PROJECT_CWD;
}

test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) {
    throw new Error("Durable chat tests require the loopback fixture server");
  }
  fixtureCwd();
  const origin = new URL(baseURL).origin;
  await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) return route.abort("blockedbyclient");
    // Automatic naming is unrelated to the tested run and must never invoke a provider.
    if (/\/api\/agent\/[^/]+\/summarize$/.test(url.pathname)) return route.fulfill({ json: { skipped: true, reason: "offline-fixture" } });
    return route.continue();
  });
});

async function createChat(page: Page, toolNames: string[] = []) {
  const response = await page.request.post("/api/agent/new", { data: {
    cwd: fixtureCwd(), engine: "durable", deferPrompt: true, type: "prompt", message: "",
    provider: PROVIDER, modelId: "deterministic", toolNames,
  } });
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json() as { sessionId: string; deferred: boolean };
  expect(body.sessionId).toMatch(/^dw_/);
  expect(body.deferred).toBe(true);
  await page.goto(`/?session=${body.sessionId}`);
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible({ timeout: 20_000 });
  return body.sessionId;
}

async function send(page: Page, message: string) {
  const sent = page.waitForResponse(response => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== `/api/agent/${currentId(page)}`) return false;
    try { return response.request().postDataJSON().type === "prompt"; } catch { return false; }
  });
  await page.getByRole("textbox", { name: "Message…", exact: true }).fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = await sent;
  expect(response.ok(), await response.text()).toBe(true);
}

async function transcript(page: Page, sessionId: string) {
  const response = await page.request.get(`/api/sessions/${sessionId}/context`);
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json() as { context: { messages: TranscriptMessage[] } };
  return body.context.messages;
}

async function completedOnce(page: Page, sessionId: string, text: string) {
  await expect(page.getByTestId("assistant-message").filter({ hasText: text })).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeEnabled();
  await expect.poll(async () => (await transcript(page, sessionId)).filter(message => message.role === "assistant" && JSON.stringify(message.content).includes(text)).length).toBe(1);
}

test("Durable chat streams real provider output, reloads mid-response, and retains exactly one final answer", async ({ page }) => {
  const sessionId = await createChat(page);
  const token = "durable-chat-stream";
  await send(page, `E2E_RECONNECT:delayed:${token}`);
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture progress ${token}.` })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const running = await page.request.get(`/api/agent/${sessionId}`);
  expect(await running.json()).toMatchObject({ running: true, state: { isStreaming: true } });
  await page.reload();
  expect(currentId(page)).toBe(sessionId);
  await completedOnce(page, sessionId, `Fixture completed ${token}.`);
  await page.reload();
  await completedOnce(page, sessionId, `Fixture completed ${token}.`);
  expect((await transcript(page, sessionId)).filter(message => message.role === "user")).toHaveLength(1);
});

test("Durable ask_user survives an unanswered reload and remains answered after another reload", async ({ page }) => {
  const sessionId = await createChat(page, ["ask_user"]);
  const token = "durable-chat-question";
  const answers: Record<string, unknown>[] = [];
  page.on("request", request => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== `/api/agent/${sessionId}`) return;
    try { const body = request.postDataJSON(); if (body.type === "extension_ui_response") answers.push(body); } catch { /* Requests without JSON are irrelevant. */ }
  });
  await send(page, `E2E_RECONNECT:question:${token}`);
  const card = page.getByTestId("inline-user-question");
  await expect(card).toBeAttached({ timeout: 20_000 });
  await page.reload();
  await expect(card).toHaveCount(1);
  await page.getByRole("button", { name: "View question", exact: true }).click();
  await card.getByRole("radio", { name: "Staging", exact: false }).click();
  await card.getByRole("button", { name: "Next", exact: true }).click();
  await card.getByRole("textbox", { name: "What should we check first?" }).fill("Verify the Durable reload receipt.");
  await card.getByRole("button", { name: "Continue", exact: true }).click();
  await completedOnce(page, sessionId, `Fixture answer received ${token}.`);
  await expect(card).toHaveCount(0);
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ answers: { target: "Staging", note: "Verify the Durable reload receipt." } });
  await page.reload();
  await completedOnce(page, sessionId, `Fixture answer received ${token}.`);
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("pending-question-notice")).toHaveCount(0);
  const results = (await transcript(page, sessionId)).filter(message => message.role === "toolResult" && message.toolName === "ask_user");
  expect(results).toHaveLength(1);
  expect(results[0].isError).not.toBe(true);
  expect(JSON.stringify(results[0].content)).toContain("Staging");
  expect(answers).toHaveLength(1);
});

test("Durable message fork keeps earlier context and separates the parent and child after reloading", async ({ page }) => {
  const parentId = await createChat(page);
  await send(page, "E2E_RECONNECT:complete:durable-fork-before");
  await completedOnce(page, parentId, "Fixture completed durable-fork-before.");
  await send(page, "E2E_RECONNECT:complete:durable-fork-target");
  await completedOnce(page, parentId, "Fixture completed durable-fork-target.");
  const user = page.locator('[data-message-role="user"]').filter({ hasText: "E2E_RECONNECT:complete:durable-fork-target" });
  await user.scrollIntoViewIfNeeded();
  await user.getByRole("button", { name: "More message actions", exact: true }).click();
  await user.getByTestId("user-message-actions").getByRole("button", { name: "New session", exact: true }).click();
  await expect.poll(() => currentId(page)).not.toBe(parentId);
  const childId = currentId(page)!;
  expect(childId).toMatch(/^dw_/);
  await completedOnce(page, childId, "Fixture completed durable-fork-before.");
  await expect(page.getByTestId("assistant-message").filter({ hasText: "Fixture completed durable-fork-target." })).toHaveCount(0);
  expect(JSON.stringify(await transcript(page, parentId))).toContain("Fixture completed durable-fork-target.");
  expect(JSON.stringify(await transcript(page, childId))).not.toContain("durable-fork-target");
  await send(page, "E2E_RECONNECT:complete:durable-fork-child");
  await completedOnce(page, childId, "Fixture completed durable-fork-child.");
  await page.reload();
  await completedOnce(page, childId, "Fixture completed durable-fork-child.");
  const childInfo = await page.request.get(`/api/sessions/${childId}`);
  expect(await childInfo.json()).toMatchObject({ info: { engine: "durable", parentSessionId: parentId } });
  expect(JSON.stringify(await transcript(page, parentId))).not.toContain("durable-fork-child");
});

test("the new-session Durable control creates a Durable conversation with the selected offline model", async ({ page }) => {
  await page.goto(`/?session=${MAIN_ID}`);
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("button", { name: "More composer controls", exact: true }).click();
  const standard = page.getByRole("button", { name: "Standard", exact: true });
  await expect(standard).toHaveAttribute("aria-pressed", "false");
  await standard.click();
  await expect(page.getByRole("button", { name: "Durable (preview)", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "More composer controls", exact: true }).click();
  await expect(page.getByTestId("model-selector-trigger")).toHaveAttribute("data-catalog-status", "ready");
  await page.getByTestId("model-selector-trigger").click();
  await page.getByRole("option", { name: /E2E deterministic offline model/ }).click();
  const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent/new" && response.request().method() === "POST");
  await page.locator("textarea").last().fill("E2E_RECONNECT:complete:durable-ui-create");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = await created;
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({ engine: "durable", deferPrompt: true, cwd: fixtureCwd(), provider: PROVIDER, modelId: "deterministic" });
  const body = await response.json() as { sessionId: string };
  expect(body.sessionId).toMatch(/^dw_/);
  await expect.poll(() => currentId(page)).toBe(body.sessionId);
  await completedOnce(page, body.sessionId, "Fixture completed durable-ui-create.");
});

test("an old conversation converts on continuation and old bookmarks, branches and pins still work", async ({ page }) => {
  const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID(); const timestamp = new Date(Date.now() - 60_000).toISOString();
  const directory = join(process.env.E2E_ROOT!, "agent", "sessions", "migration-browser"); mkdirSync(directory, { recursive: true });
  const path = join(directory, `${id}.jsonl`);
  const base = (id: string, parentId: string | null) => ({ id, parentId, timestamp });
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], model: "deterministic", provider: PROVIDER, api: PROVIDER, stopReason: "stop", timestamp: Date.parse(timestamp), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const entries = [
    { type: "session", version: 3, id, timestamp, cwd: fixtureCwd() },
    { ...base("old-model", null), type: "model_change", provider: PROVIDER, modelId: "deterministic" },
    { ...base("old-question", "old-model"), type: "message", message: { role: "user", content: "Old saved question", timestamp: Date.parse(timestamp) } },
    { ...base("old-alternate", "old-question"), type: "message", message: assistant("Old alternate answer") },
    { ...base("old-answer", "old-question"), type: "message", message: assistant("Old selected answer") },
    { ...base("old-name", "old-answer"), type: "session_info", name: "Automatic migration browser fixture" },
  ];
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await page.request.post("/api/sessions/pins", { data: { id } });
  await page.goto(`/?session=${id}`);
  await expect(page.getByTestId("assistant-message").filter({ hasText: "Old selected answer" })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeEnabled();
  let source = readFileSync(path, "utf8");
  // Opening the old SDK can append its default thinking setting. Capture the
  // authoritative source at prompt admission, immediately before conversion.
  page.on("request", item => {
    if (item.method() === "POST" && new URL(item.url()).pathname === `/api/agent/${id}`) source = readFileSync(path, "utf8");
  });
  const response = page.waitForResponse(item => item.request().method() === "POST" && new URL(item.url()).pathname === `/api/agent/${id}`);
  await page.getByRole("textbox", { name: "Message…", exact: true }).fill("E2E_RECONNECT:complete:automatic-migration");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const result = await response; expect(result.ok(), await result.text()).toBe(true);
  expect(await result.json()).toMatchObject({ migration: { status: "converted", sourceId: id } });
  await expect.poll(() => currentId(page)).toMatch(/^dw_/);
  const converted = currentId(page)!;
  await completedOnce(page, converted, "Fixture completed automatic-migration.");
  expect(readFileSync(path, "utf8")).toBe(source);
  const savedPins = await (await page.request.get("/api/sessions/pins")).json(); expect(savedPins.pinned).toContain(converted); expect(savedPins.pinned).not.toContain(id);
  const alternate = await (await page.request.get(`/api/sessions/${id}/context?leafId=old-alternate`)).json();
  expect(JSON.stringify(alternate.context.messages)).toContain("Old alternate answer"); expect(JSON.stringify(alternate.context.messages)).not.toContain("Old selected answer");
  await page.goto(`/?session=${id}`);
  await expect.poll(() => currentId(page)).toBe(converted);
  await completedOnce(page, converted, "Fixture completed automatic-migration.");
  await expect(page.getByTestId("assistant-message").filter({ hasText: "Old selected answer" })).toHaveCount(1);
});
