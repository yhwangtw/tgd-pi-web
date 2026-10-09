import { expect, test } from "@playwright/test";

test("creates and displays an official Durable run through the existing offline model runtime", async ({ page }) => {
  await page.goto("/?session=aaaa1111-2222-3333-4444-555566667777");
  await expect(page.getByRole("textbox", { name: "Message…" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByTestId("agent-new-run").click();
  await page.getByLabel("Run name").fill("Durable offline verification");
  await page.getByLabel("Prompt", { exact: true }).fill("E2E_RECONNECT:complete:durable-offline");
  await page.getByText("Execution, model and tools", { exact: true }).click();
  await page.getByLabel("Execution mode", { exact: true }).selectOption("durable");
  await expect(page.getByText(/Pi Durable saves progress/)).toBeVisible();
  const model = page.getByLabel("Model", { exact: true });
  await expect(model.locator("option").filter({ hasText: "E2E deterministic offline model" })).toBeAttached();
  await model.selectOption({ label: "E2E deterministic offline model" });
  const submitted = page.waitForResponse(response => response.url().endsWith("/api/agent-runs") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start background run", exact: true }).click();
  const response = await submitted;
  expect(response.status()).toBe(202);
  const body = await response.json();
  expect(body.run.engine).toBe("durable");
  expect(body.run.toolNames).not.toContain("ask_user");
  const card = page.getByTestId("agent-run-card").filter({ hasText: "Durable offline verification" });
  await expect(card).toHaveAttribute("data-status", "completed", { timeout: 20_000 });
  await card.getByRole("button", { name: "View activity", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Durable offline verification", exact: true });
  await expect(dialog.getByText(/Fixture completed durable-offline/)).toBeVisible();
  await expect(dialog.locator("[data-chat-cwd]")).toHaveAttribute("data-chat-cwd", body.run.cwd);
});

test("cancels a running Durable request through the Agent dashboard", async ({ page, request }) => {
  const response = await request.post("/api/agent-runs", { data: {
    name: "Durable cancel verification", cwd: process.env.E2E_PROJECT_CWD,
    prompt: "E2E_RECONNECT:delayed:durable-cancel", engine: "durable",
    provider: "e2e-reconnect-fixture", modelId: "deterministic", toolNames: [],
  } });
  expect(response.status()).toBe(202);
  const { run } = await response.json();
  await page.goto("/?session=aaaa1111-2222-3333-4444-555566667777");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const card = page.getByTestId("agent-run-card").filter({ hasText: run.name });
  await expect(card).toHaveAttribute("data-status", "running");
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card).toHaveAttribute("data-status", "cancelled");
  await page.reload();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByTestId("agent-run-card").filter({ hasText: run.name })).toHaveAttribute("data-status", "cancelled");
});
