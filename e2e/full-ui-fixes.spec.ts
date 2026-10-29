import { expect, test, type Page } from "@playwright/test";
import type { Details } from "pi-subagents/shared-types";
import { writeFileSync } from "node:fs";
type WorkflowSnapshot = NonNullable<Details["workflowChildren"]>;
type SubagentObserverWindow = Window & { upstreamSubagentObserver?: { source: EventSource; snapshots: WorkflowSnapshot[]; events: unknown[] } };
const PROVIDER = "e2e-reconnect-fixture";
const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Local fixture required");
  const origin = new URL(baseURL).origin;
  await context.addInitScript(() => { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-ui-style", "original"); });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) return route.abort();
    if (url.pathname.endsWith("/summarize")) return route.fulfill({ json: { skipped: true } });
    return route.continue();
  });
});
async function create(page: Page, toolNames: string[] = []) {
  const response = await page.request.post("/api/agent/new", { data: { cwd: process.env.E2E_PROJECT_CWD, deferPrompt: true, provider: PROVIDER, modelId: "deterministic", type: "prompt", message: "", toolNames } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).sessionId as string;
}
test("queue edits, reorder, remove, clear and reconnect preserve the active reply", async ({ page }, info) => {
  const id = await create(page);
  await page.goto(`/?session=${id}`);
  const input = page.locator("textarea").last();
  await expect(input).toBeVisible();
  await input.fill(`E2E_RECONNECT:delayed:queue-fix`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture progress queue-fix.` })).toBeVisible();
  const queue = page.getByRole("region", { name: "Queued follow-ups", exact: true });
  const add = async (token: string) => {
    await page.getByRole("group", { name: "Message delivery mode" }).getByRole("button", { name: "Follow-up", exact: true }).click();
    await input.fill(`E2E_RECONNECT:complete:${token}`);
    await page.getByRole("button", { name: "Queue until the current run finishes (Command+Enter)", exact: true }).click();
    await expect(queue).toContainText(token);
  };
  await add(`queue-first`); await add(`queue-second`);
  await queue.getByRole("button", { name: "Move earlier", exact: true }).nth(1).click();
  await expect(queue.locator("li").first()).toContainText(`queue-second`);
  await queue.getByRole("button", { name: "Edit queued follow-up", exact: true }).first().click();
  await queue.getByRole("textbox", { name: "Edit queued follow-up" }).fill(`E2E_RECONNECT:complete:queue-edited`);
  await queue.getByRole("button", { name: "Save", exact: true }).click();
  await expect(queue.locator("li").first()).toContainText(`queue-edited`);
  await queue.getByRole("button", { name: "Remove queued follow-up", exact: true }).last().click();
  await expect(queue.locator("li")).toHaveCount(1);
  await queue.getByRole("button", { name: "Cancel all", exact: true }).click();
  await expect(queue).toHaveCount(0);
  await add(`queue-survivor`);
  await page.reload();
  await expect(queue).toContainText(`queue-survivor`);
  await page.screenshot({ path: info.outputPath(`queue.png`) });
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture completed queue-survivor.` })).toHaveCount(1, { timeout: 45_000 });
  await expect(queue).toHaveCount(0);
  const response = await page.request.get(`/api/sessions/${id}/context`);
  const data = await response.json();
  const text = JSON.stringify(data.context.messages);
  expect(text).not.toContain(`Fixture completed queue-first.`);
  expect(text).not.toContain(`Fixture completed queue-edited.`);
});

test("Stop during slow initial snapshot preserves the draft and never starts a prompt", async ({ page }) => {
  const id = await create(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/agent/${id}/events*`, async route => { await gate; await route.continue(); });
  const prompts: unknown[] = [];
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === `/api/agent/${id}` && request.postDataJSON()?.type === "prompt") prompts.push(request.postDataJSON()); });
  await page.goto(`/?session=${id}`);
  const input = page.locator("textarea").last();
  await expect(input).toBeVisible();
  await input.fill("E2E_RECONNECT:complete:cancel-before-start");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const monitor = page.getByTestId("run-monitor");
  await expect(monitor).toBeVisible();
  await expect(monitor).toHaveAttribute("data-progress-state", "connecting");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(input).toHaveValue("E2E_RECONNECT:complete:cancel-before-start");
  release();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(prompts).toEqual([]);
});

test("Session menu supports keyboard movement, Escape and focus return", async ({ page }) => {
  await page.goto(MAIN);
  const trigger = page.getByRole("button", { name: "Session actions", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("Large source stays bounded after loading more and line jumps", async ({ page }, info) => {
  await page.goto(MAIN);
  await page.getByRole("button", { name: /^(Explorer|Files)$/, exact: true }).first().click();
  await page.getByRole("treeitem", { name: "large-preview.txt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next lines", exact: true })).toBeVisible();
  expect(await page.locator("[data-line-number]").count()).toBeLessThanOrEqual(500);
  await page.getByRole("button", { name: "Next lines", exact: true }).click();
  await expect(page.locator('[data-line-number="501"]')).toBeVisible();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.getByText(/Loaded 512/)).toBeVisible();
  await page.locator("input[placeholder='find / :line']").fill(":15000");
  await expect(page.locator('[data-line-number="15000"][data-active-line]')).toBeVisible();
  expect(await page.locator("[data-line-number]").count()).toBeLessThanOrEqual(500);
  await page.screenshot({ path: info.outputPath("bounded-source.png") });
});

for (const width of [390, 1440]) test(`Original unread and mobile control sizes at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(MAIN);
  if (width === 390) await page.getByRole("button", { name: "Sessions", exact: true }).click();
  const unread = page.getByRole("button", { name: /^Unread conversations \d+$/ });
  await expect(unread).toBeVisible();
  await unread.click();
  await expect(unread).toHaveAttribute("aria-pressed", "true");
  await unread.click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  if (width === 390) expect((await unread.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath(`original-${width}.png`) });
});

for (const partial of [false, true]) test(`Pi subagent ${partial ? "partial failure" : "parallel success"} reaches the transcript and work log`, async ({ page }, info) => {
  const id = await create(page, ["subagent"]);
  const token = `${partial ? "partial" : "success"}-audit-${id}`;
  await page.goto(`/?session=${id}`);
  // Observe the real upstream foreground lifecycle; these children do not
  // belong to the dashboard's background-only async snapshot.
  await page.evaluate(sessionId => new Promise<void>((resolve, reject) => {
    const source = new EventSource(`/api/agent/${sessionId}/events`);
    const observer = { source, snapshots: [] as WorkflowSnapshot[], events: [] as unknown[] };
    (window as SubagentObserverWindow).upstreamSubagentObserver = observer;
    const timer = setTimeout(() => { source.close(); reject(new Error("Subagent event observer did not connect")); }, 10_000);
    source.onopen = () => { clearTimeout(timer); resolve(); };
    source.onerror = () => { clearTimeout(timer); source.close(); reject(new Error("Subagent event observer disconnected")); };
    let previous = "";
    source.onmessage = event => {
      const frame = JSON.parse(event.data);
      if (frame.type.startsWith("tool_") && observer.events.length < 128) observer.events.push(frame);
      if (frame.type !== "tool_execution_update" || frame.toolName !== "subagent") return;
      const summary = frame.partialResult?.details?.workflowChildren as WorkflowSnapshot | undefined;
      if (!summary) return;
      const signature = JSON.stringify([summary.workflowState, summary.children.map(child => [child.childId, child.runId, child.state])]);
      if (signature !== previous && observer.snapshots.length < 128) observer.snapshots.push(summary);
      previous = signature;
    };
  }), id);
  let result: { isError: boolean; details: Partial<Details>; content: Array<{ type: string; text?: string }> } | undefined;
  try {
    const input = page.locator("textarea").last();
    await input.fill(`E2E_RECONNECT:subagents:${token}`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture delegation verified ${token}.` })).toBeVisible({ timeout: 30_000 });
    const response = await page.request.get(`/api/sessions/${id}/context`);
    expect(response.ok()).toBe(true);
    const data = await response.json();
    result = data.context.messages.find((message: { role: string; toolName?: string }) => message.role === "toolResult" && message.toolName === "subagent");
    expect(result).toBeDefined();
    expect(result!.isError).toBe(partial);
    const snapshots = await page.evaluate(() => (window as SubagentObserverWindow).upstreamSubagentObserver?.snapshots ?? []);
    // Agent metadata belongs to running launches; upstream omits it once a
    // child settles. Bind final results/call trace to these actual run ids.
    const overlap = snapshots.find(snapshot => snapshot.children.length === 2 && ["task-1", "task-2"].every(childId => snapshot.children.some(child => child.childId === childId && child.agent === "scout" && !!child.runId && child.state === "running")));
    expect(overlap, "Both actual upstream child runs must be observed running together").toBeDefined();
    const runningChildren = [...overlap!.children].sort((a, b) => a.childId.localeCompare(b.childId));
    expect(new Set(runningChildren.map(child => child.runId)).size).toBe(2);
    if (partial) {
      const output = result!.content.map(part => part.text ?? "").join("");
      expect(output).toContain("Workflow failed:");
      expect(output).toContain(`task-2 (scout) failed: Fixture reconnect failure child-b-${token}`);
      expect(output).toContain(`- run task-1: completed (${runningChildren[0].runId})`);
      expect(output).toContain(`- run task-2: failed (${runningChildren[1].runId})`);
      expect(result!.details.results).toBeUndefined();
    } else {
      const details = result!.details as Details;
      expect(details.mode).toBe("workflow");
      expect(details.results).toHaveLength(2);
      const children = [...details.results].sort((a, b) => a.workflowKey!.localeCompare(b.workflowKey!));
      expect(children.map(child => child.workflowKey)).toEqual(["task-1", "task-2"]);
      for (const [index, child] of children.entries()) {
        const childToken = `child-${index === 0 ? "a" : "b"}-${token}`;
        expect(child.agent).toBe("scout");
        expect(child.runId).toBe(runningChildren[index].runId);
        expect(child.task.split("\n\n---\n**Output:**\n", 1)[0]).toBe(`E2E_RECONNECT:delayed:${childToken}`);
        expect(child.exitCode).toBe(0);
        const output = child.finalOutput ?? JSON.stringify(child.messages ?? []);
        expect(output).toContain(`Fixture parallel sibling observed ${childToken}.`);
        expect(output).toContain(`Fixture completed ${childToken}.`);
      }
      const summary = details.workflowChildren!;
      expect(summary.inventoryComplete).toBe(true);
      expect(summary.workflowState).toBe("completed");
      expect([...summary.children].sort((a, b) => a.childId.localeCompare(b.childId)).map(child => ({ childId: child.childId, runId: child.runId, state: child.state }))).toEqual(children.map(child => ({ childId: child.workflowKey, runId: child.runId, state: "completed" })));
    }
    await expect(page.getByRole("region", { name: "Work log", exact: true }).getByRole("button", { name: partial ? /Answer received/ : /Completed/ })).toBeVisible();
    expect(await page.locator("body").textContent()).not.toContain("[object Object]");
  } finally {
    const observed = await page.evaluate(() => {
      const observer = (window as SubagentObserverWindow).upstreamSubagentObserver;
      observer?.source.close();
      return { snapshots: observer?.snapshots ?? [], events: observer?.events ?? [] };
    });
    const evidencePath = info.outputPath("upstream-evidence.json");
    writeFileSync(evidencePath, JSON.stringify({ sessionId: id, token, ...observed, result }, null, 2));
    await info.attach("upstream-subagent-workflow-evidence", { path: evidencePath, contentType: "application/json" });
  }
});

test("Schedule delete confirmation has a cancel exit and resets on edit", async ({ page }) => {
  const schedule = { id: "cancel-only", name: "Disposable confirmation fixture", cwd: process.env.E2E_PROJECT_CWD,
    prompt: "Unused", timing: { kind: "daily", time: "09:00" }, timezone: "Asia/Taipei", enabled: false,
    missedRunPolicy: "skip", toolNames: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextRunAt: null };
  await page.route("**/api/schedules", route => route.fulfill({ json: { schedules: [schedule], runs: [], serverTime: new Date().toISOString() } }));
  const mutations: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/schedules/") && request.method() !== "GET") mutations.push(request.method()); });
  await page.goto(MAIN);
  await page.getByRole("button", { name: "Schedules", exact: true }).click();
  const card = page.getByTestId("schedule-panel").getByRole("article").filter({ hasText: schedule.name });
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(card).toContainText(`Delete this schedule? · ${schedule.name}`);
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await card.getByRole("button", { name: "Edit schedule", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit schedule", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test("Steer remains usable during a reply", async ({ page }) => {
  const id = await create(page);
  await page.goto(`/?session=${id}`);
  const input = page.locator("textarea").last();
  await input.fill(`E2E_RECONNECT:delayed:steer-before`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture progress steer-before.` })).toBeVisible();
  await page.getByRole("group", { name: "Message delivery mode" }).getByRole("button", { name: "Steer", exact: true }).click();
  await input.fill(`E2E_RECONNECT:complete:steer-after`);
  await page.getByRole("button", { name: "Queue for the next model call (Option+Enter)", exact: true }).click();
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture completed steer-after.` })).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});

for (const width of [390, 1440]) test(`${width}: selected file actions are visible, keyboard usable and stay inside the viewport`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(MAIN);
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
  const files = page.getByRole("button", { name: /^(Explorer|Files)$/ }).first();
  await files.click();
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await expect(page.locator(".right-panel-container.right-panel-open")).toBeVisible();
  const trigger = page.getByRole("button", { name: "More file actions: README.md", exact: true });
  // Opening a file intentionally collapses the sidebar below 1600px.
  await expect(page.locator(".sidebar-container")).not.toHaveClass(/sidebar-open/);
  await files.click();
  await expect(trigger).toBeVisible();
  const input = page.locator("textarea").last();
  const draft = await input.inputValue();
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  const rect = (await menu.boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(844);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(input).toHaveValue(draft);
  if (width > 700) {
    await trigger.hover();
    const mention = page.getByRole("button", { name: "Insert @ mention: README.md", exact: true });
    await expect(mention).toBeVisible();
    const moreRect = (await trigger.boundingBox())!;
    const mentionRect = (await mention.boundingBox())!;
    expect(moreRect.x + moreRect.width).toBeLessThanOrEqual(mentionRect.x);
    await mention.click();
    await expect(input).toHaveValue(/README\.md/);
  }
});
