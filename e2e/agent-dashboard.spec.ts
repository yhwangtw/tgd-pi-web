import { expect, test, type Page, type Route } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

interface MockRun {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  trigger: "manual" | "retry";
  toolNames: string[];
  createdAt: string;
  status: string;
  sessionId?: string;
  workspace?: { repoRoot: string; branch: string | null; isMain: boolean };
}

async function openDashboard(page: Page, initialRuns: MockRun[]) {
  let runs = [...initialRuns];
  let maxConcurrency = 3;
  await page.route("**/api/models", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ modelList: [] }),
  }));
  await page.route("**/api/agent-runs**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runs,
          counts: {},
          maxConcurrency,
          serverTime: "2026-07-26T03:00:00.000Z",
          nextCursor: null,
        }),
      });
      return;
    }
    if (url.pathname === "/api/agent-runs" && request.method() === "PATCH") {
      const input = request.postDataJSON() as { maxConcurrency: number };
      maxConcurrency = input.maxConcurrency;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ maxConcurrency }),
      });
      return;
    }
    if (url.pathname === "/api/agent-runs" && request.method() === "POST") {
      const input = request.postDataJSON() as {
        name: string;
        cwd: string;
        prompt: string;
        toolNames: string[];
      };
      const run: MockRun = {
        ...input,
        id: "created-run",
        trigger: "manual",
        status: "queued",
        createdAt: "2026-07-26T03:00:00.000Z",
        workspace: { repoRoot: input.cwd, branch: "feature/new", isMain: true },
      };
      runs = [run, ...runs];
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ run }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ run: runs[0] }),
    });
  });

  await page.goto(MAIN);
  await expect(page.getByRole("textbox", { name: "Message…" })).toBeVisible({ timeout: 20_000 });
  if ((page.viewportSize()?.width ?? 0) <= 700) {
    await page.getByRole("button", { name: "More", exact: true }).click();
  }
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByTestId("agent-dashboard")).toBeVisible();
}

test("AC-4.1: dashboard groups parallel worktree runs under their repository", async ({ page }) => {
  await openDashboard(page, [
    {
      id: "run-main",
      name: "Main review",
      cwd: "/tmp/repo",
      prompt: "Review main",
      trigger: "manual",
      toolNames: ["read"],
      createdAt: "2026-07-26T02:00:00.000Z",
      status: "running",
      sessionId: "session-main",
      workspace: { repoRoot: "/tmp/repo", branch: "main", isMain: true },
    },
    {
      id: "run-worktree",
      name: "Feature implementation",
      cwd: "/tmp/repo/.worktrees/feature",
      prompt: "Implement feature",
      trigger: "manual",
      toolNames: ["read", "edit", "write"],
      createdAt: "2026-07-26T02:01:00.000Z",
      status: "waiting_for_input",
      sessionId: "session-feature",
      workspace: { repoRoot: "/tmp/repo", branch: "feature/dashboard", isMain: false },
    },
  ]);

  await expect(page.getByText("/tmp/repo", { exact: true })).toHaveCount(2);
  const dashboard = page.getByTestId("agent-dashboard");
  await expect(dashboard.getByText("main", { exact: true })).toBeVisible();
  await expect(dashboard.getByText("feature/dashboard", { exact: true })).toBeVisible();
  await expect(page.getByText("Waiting for input", { exact: true })).toBeVisible();
  await expect(page.getByTestId("agent-run-card")).toHaveCount(2);
});

test("AC-4.2: coding access is explicit and the run remains queued in the daemon", async ({ page }) => {
  await openDashboard(page, []);

  await page.getByTestId("agent-new-run").click();
  await page.getByLabel("Run name").fill("Build dashboard");
  await page.getByLabel("Prompt").fill("Implement and verify the dashboard");
  await page.getByText("Model and tool access", { exact: true }).click();
  await page.getByRole("button", { name: "Coding", exact: true }).click();
  await expect(page.getByText(/may edit files and run shell commands/)).toBeVisible();

  const createRequest = page.waitForRequest((request) => (
    request.url().endsWith("/api/agent-runs") && request.method() === "POST"
  ));
  await page.getByRole("button", { name: "Start background run", exact: true }).click();
  const body = (await createRequest).postDataJSON() as { toolNames: string[] };
  expect(body.toolNames).toEqual(expect.arrayContaining(["bash", "edit", "write"]));

  await expect(page.getByTestId("agent-dashboard")).toBeVisible();
  await expect(page.getByText("Build dashboard", { exact: true })).toBeVisible();
  await expect(page.getByText("Queued", { exact: true }).last()).toBeVisible();
});

test("AC-4.3: dashboard remains usable at 320px without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openDashboard(page, []);

  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
  await expect(page.getByTestId("agent-new-run")).toBeVisible();
});

test("AC-4.5: concurrent slots can be changed from the dashboard", async ({ page }) => {
  await openDashboard(page, []);
  const select = page.getByRole("combobox", { name: "Concurrent agent slots", exact: true });
  await expect(select).toHaveValue("3");

  const updateRequest = page.waitForRequest((request) => (
    request.url().endsWith("/api/agent-runs") && request.method() === "PATCH"
  ));
  await select.selectOption("6");
  const body = (await updateRequest).postDataJSON() as { maxConcurrency: number };

  expect(body).toEqual({ maxConcurrency: 6 });
  await expect(select).toHaveValue("6");
});
