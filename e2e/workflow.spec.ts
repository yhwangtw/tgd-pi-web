import { expect, test } from "@playwright/test";

const SESSION = "aaaa1111-2222-3333-4444-555566667777";

for (const width of [390, 1440]) test(`Goal and Plan controls preserve a draft and remain usable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  const commands: Record<string, unknown>[] = [];
  const forbidden: string[] = [];
  const state = { isStreaming: true, model: { provider: "fixture", id: "offline" } };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === `/api/agent/${SESSION}`) return route.fulfill({ json: { running: true, state } });
      return route.continue();
    }
    if (path === "/api/worktrees") return route.fulfill({ json: { worktrees: [] } });
    if (path.endsWith("/summarize")) return route.fulfill({ json: { skipped: true } });
    const command = request.postDataJSON();
    if (path === `/api/agent/${SESSION}` && ["workflow_command", "get_tools"].includes(command.type)) {
      commands.push(command);
      return route.fulfill({ json: { success: true, data: command.type === "get_tools" ? [] : null } });
    }
    forbidden.push(path);
    return route.fulfill({ status: 403, json: { error: "No model calls or persistent writes in this fixture" } });
  });
  await page.route(new RegExp(`/api/sessions/${SESSION}(?:\\?|$)`), async route => {
    const response = await route.fetch(); const data = await response.json();
    await route.fulfill({ response, json: { ...data, agentState: { running: true, state } } });
  });
  await page.route(new RegExp(`/api/agent/${SESSION}/events(?:\\?|$)`), route => route.fulfill({
    contentType: "text/event-stream", body: "retry: 60000\n" + [
      { type: "session_snapshot", sessionId: SESSION, state },
      { type: "extension_ui_request", id: "goal-widget", method: "setWidget", widgetKey: "Goal", widgetPlacement: "aboveEditor", widgetLines: ["Fix the message experience", "Continue until verified"] },
      { type: "extension_ui_request", id: "plan-widget", method: "setWidget", widgetKey: "Plan", widgetPlacement: "aboveEditor", widgetLines: ["Message experience plan", "✓ 1. Inspect output", "→ 2. Verify the fix"] },
      { type: "extension_ui_request", id: "goal-status", method: "setStatus", statusKey: "Goal", statusText: "active · 100 tokens" },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
  }));
  await page.goto(`/?session=${SESSION}`);
  const goal = page.getByTestId("workflow-goal"); const plan = page.getByTestId("workflow-plan");
  await expect(goal).toBeVisible(); await expect(plan).toBeVisible();
  const input = page.locator("textarea").last();
  await input.fill("Keep this draft");
  await goal.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => commands.filter(c => c.type === "workflow_command")).toEqual([{ type: "workflow_command", command: "goal", args: "pause" }]);
  await expect(input).toHaveValue("Keep this draft");
  await plan.locator("summary").click();
  await expect(plan).toContainText("Verify the fix");
  await expect(plan.getByRole("button", { name: "Execute plan" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: test.info().outputPath(`workflow-${width}.png`) });
  await plan.getByRole("button", { name: "Execute plan" }).click();
  await expect.poll(() => commands.filter(c => c.type === "workflow_command").at(-1)).toEqual({ type: "workflow_command", command: "plan", args: "execute" });
  await page.reload();
  await expect(goal).toContainText("Fix the message experience");
  await expect(input).toHaveValue("Keep this draft");
  expect(forbidden).toEqual([]);
});
