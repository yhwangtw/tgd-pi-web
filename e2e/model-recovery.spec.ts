import { expect, test as base, type Locator, type Page, type Route } from "@playwright/test";
import { realpathSync } from "node:fs";
import path from "node:path";

const MAIN_ID = "aaaa1111-2222-3333-4444-555566667777";
const ARCHIVE_ID = "cccc2222-3333-4444-5555-666677778888";
const MODEL_API = /\/api\/models(?:\?|$)/;
const ALPHA = "Fixture Alpha model";
const ALTERNATE = "Fixture Alpha alternate";
const BETA = "Fixture Beta model";

function catalog(name: string, provider = "fixture-alpha", alternate = false) {
  const modelList = [{ id: "fixture-model", provider, name, available: true, contextWindow: 32_768, maxTokens: 2_048 }];
  if (alternate) modelList.push({ ...modelList[0], id: "fixture-alternate", name: ALTERNATE });
  return { modelList, defaultModel: { provider, modelId: "fixture-model" }, thinkingLevels: {}, thinkingLevelMaps: {} };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const test = base.extend<{ modelNetworkSafety: void }>({
  modelNetworkSafety: [async ({ page }, use) => {
    const forbidden: string[] = [];
    await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
    // No prompt, connection test, credential write, or session mutation may
    // reach the fixture server. Even an accidental click cannot call a model.
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (["GET", "HEAD"].includes(request.method())) return route.continue();
      if (request.method() === "POST" && ["/api/models", "/api/cwd/browse", "/api/cwd/validate"].includes(pathname)) return route.continue();
      let body: Record<string, unknown> | undefined;
      try { body = request.postDataJSON(); } catch { /* Invalid mutation bodies remain blocked. */ }
      // This POST is a bounded, read-only batch of repository/branch labels,
      // not worktree creation. Do not allow a future action-shaped body here.
      if (request.method() === "POST" && pathname === "/api/worktrees" && body
        && Object.keys(body).length === 1 && Array.isArray(body.cwds) && body.cwds.length <= 128
        && body.cwds.every((cwd) => typeof cwd === "string" && cwd.length > 0)) return route.continue();
      if (request.method() === "POST" && /^\/api\/agent\/[^/]+$/.test(pathname) && body?.type === "get_tools") {
        return route.fulfill({ json: { success: true, data: [] } });
      }
      forbidden.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 403, json: { error: "Model recovery E2E forbids mutations and model calls" } });
    });
    // Other specs may activate fixture runtimes. These cases always start from
    // read-only stored history; the SSE case overrides only its own response.
    await page.route(/\/api\/sessions\/[^/?]+\?includeState$/, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, agentState: { running: false } } });
    });
    await page.route("**/api/models-config", (route) => route.request().method() === "GET"
      ? route.fulfill({
        headers: { "Content-Type": "application/json", ETag: '"missing"', "X-Models-Config-Path": encodeURIComponent("/fixture-only/agent/models.json") },
        json: { providers: {} },
      })
      : route.fallback());
    await page.route(/\/api\/auth\/(?:providers|all-providers)$/, (route) => route.request().method() === "GET"
      ? route.fulfill({ json: { providers: [] } }) : route.fallback());
    await page.route("**/api/provider-health", (route) => route.fulfill({ json: {
      checkedAt: "2026-09-07T00:00:00Z",
      summary: { ready: 0, warning: 0, invalid: 0, needsAuth: 0, total: 0 },
      coverage: { credentialReadiness: "checked", localCatalog: "checked", quotaAndBilling: "not_checked", upstreamAvailability: "not_checked" },
      providers: [],
    } }));
    await use();
    expect(forbidden, "No model request or persistent mutation should be attempted").toEqual([]);
  }, { auto: true }],
});

async function openMain(page: Page, composerName = "Message…") {
  await page.goto(`/?session=${MAIN_ID}`);
  await expect(page.getByRole("textbox", { name: composerName })).toBeVisible({ timeout: 20_000 });
}

function trigger(page: Page) { return page.getByTestId("model-selector-trigger"); }
function recovery(page: Page) { return page.getByRole("dialog", { name: "Choose a model", exact: true }); }

async function expectDesktopModels(page: Page, name: string, absent?: string) {
  await expect(trigger(page)).toHaveAttribute("data-catalog-status", "ready");
  await trigger(page).click();
  const options = page.getByRole("listbox", { name: "Model", exact: true });
  await expect(options.getByRole("option", { name: new RegExp(name) })).toBeVisible();
  if (absent) await expect(options.getByRole("option", { name: new RegExp(absent) })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

async function switchToArchive(page: Page) {
  await page.getByRole("listbox", { name: "Sessions", exact: true }).getByText("跨專案歷史對話", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`session=${ARCHIVE_ID}`));
}

async function expectWithinViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  await expect(locator).toBeInViewport();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test("loading keeps the model entry and recovery actions visible until the catalog arrives", async ({ page }) => {
  const ready = deferred();
  await page.route(MODEL_API, async (route) => { await ready.promise; await route.fulfill({ json: catalog(ALPHA) }); });
  try {
    await openMain(page);
    await expect(trigger(page)).toHaveAttribute("data-catalog-status", "loading");
    await expect(trigger(page)).toBeEnabled();
    await trigger(page).click();
    await expect(recovery(page).getByRole("status")).toHaveText("Loading models…");
    await expect(page.getByTestId("model-catalog-retry")).toBeDisabled();
    await expect(page.getByTestId("model-catalog-configure")).toBeEnabled();
    await recovery(page).getByRole("button", { name: "Close", exact: true }).click();
    ready.resolve();
    await expectDesktopModels(page, ALPHA);
  } finally { ready.resolve(); }
});

test("empty catalog opens Models and shows the zero-configuration next step", async ({ page }) => {
  await page.route(MODEL_API, (route) => route.fulfill({ json: { modelList: [], diagnostics: [{ type: "missing_credentials", message: "Fixture provider has no credentials." }] } }));
  await openMain(page);
  await expect(trigger(page)).toHaveAttribute("data-catalog-status", "empty");
  await trigger(page).click();
  await expect(recovery(page).getByRole("status")).toHaveText("No models available");
  await expect(recovery(page)).toContainText("Fixture provider has no credentials.");
  await page.getByTestId("model-catalog-configure").click();
  const models = page.getByTestId("models-config-dialog");
  await expect(models).toBeVisible();
  await expect(models).toContainText("/fixture-only/agent/models.json");
  const health = models.getByTestId("provider-health");
  await expect(health).toContainText("No provider configured");
  await expect(health.getByRole("button", { name: "Add provider", exact: true })).toBeEnabled();
  await expect(models.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("failed catalog can be retried without losing the permanent selector", async ({ page }) => {
  let attempts = 0;
  let recovered = false;
  await page.route(MODEL_API, (route) => {
    attempts += 1;
    return recovered ? route.fulfill({ json: catalog(BETA, "fixture-beta") })
      : route.fulfill({ status: 503, json: { error: "Fixture catalog unavailable" } });
  });
  await openMain(page);
  await expect(trigger(page)).toHaveAttribute("data-catalog-status", "error");
  await trigger(page).click();
  await expect(recovery(page).getByRole("status")).toHaveText("Could not load models");
  const previousAttempts = attempts;
  recovered = true;
  await page.getByTestId("model-catalog-retry").click();
  await expect.poll(() => attempts).toBeGreaterThan(previousAttempts);
  await expect(trigger(page)).toHaveAttribute("data-catalog-status", "ready");
  // Recovery closes its old surface; the permanent entry opens the new list.
  await expect(recovery(page)).toHaveCount(0);
  await expectDesktopModels(page, BETA);
});

for (const closeAction of ["Close", "Cancel"]) {
  test(`new conversation keeps a manually chosen model after Models ${closeAction} refreshes the catalog`, async ({ page }) => {
    let catalogsLoaded = 0;
    await page.route(MODEL_API, (route) => {
      catalogsLoaded += 1;
      return route.fulfill({ json: catalog(ALPHA, "fixture-alpha", true) });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(trigger(page)).toHaveAttribute("data-catalog-status", "ready");
    await trigger(page).click();
    await page.getByRole("listbox", { name: "Model", exact: true })
      .getByRole("option", { name: new RegExp(ALTERNATE) }).click();
    await expect(trigger(page)).toContainText(ALTERNATE);
    const draft = "Keep this draft; do not submit.";
    await page.getByRole("textbox", { name: "Message…", exact: true }).fill(draft);
    const beforeRefresh = catalogsLoaded;
    await page.getByRole("navigation", { name: "Primary navigation" })
      .getByRole("button", { name: "Models", exact: true }).click();
    const models = page.getByTestId("models-config-dialog");
    await expect(models).toBeVisible();
    await models.getByRole("button", { name: closeAction, exact: true }).click();
    await expect(models).toBeHidden();
    await expect.poll(() => catalogsLoaded).toBeGreaterThan(beforeRefresh);
    await expect(trigger(page)).toHaveAttribute("data-catalog-status", "ready");
    await expect(trigger(page)).toContainText(ALTERNATE);
    await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toHaveValue(draft);
  });
}

test("changing sessions clears old options while the new source is loading", async ({ page }) => {
  const betaReady = deferred();
  await page.route(MODEL_API, async (route) => {
    if (new URL(route.request().url()).searchParams.get("sessionId") === ARCHIVE_ID) {
      await betaReady.promise;
      return route.fulfill({ json: catalog(BETA, "fixture-beta") });
    }
    return route.fulfill({ json: catalog(ALPHA) });
  });
  try {
    await openMain(page);
    await expectDesktopModels(page, ALPHA);
    await switchToArchive(page);
    await expect(trigger(page)).toHaveAttribute("data-catalog-status", "loading");
    await trigger(page).click();
    await expect(recovery(page).getByRole("status")).toHaveText("Loading models…");
    await expect(recovery(page)).not.toContainText(ALPHA);
    await expect(page.getByRole("listbox", { name: "Model", exact: true })).toHaveCount(0);
    await recovery(page).getByRole("button", { name: "Close", exact: true }).click();
    betaReady.resolve();
    await expectDesktopModels(page, BETA, ALPHA);
  } finally { betaReady.resolve(); }
});

test("a late previous-session response cannot replace the current catalog", async ({ page }) => {
  const alphaReady = deferred();
  const alphaSettled = deferred();
  let alphaRequested = false;
  await page.route(MODEL_API, async (route) => {
    if (new URL(route.request().url()).searchParams.get("sessionId") !== MAIN_ID) return route.fulfill({ json: catalog(BETA, "fixture-beta") });
    alphaRequested = true;
    await alphaReady.promise;
    // A canceled browser request may no longer accept its deliberately late
    // response; cancellation is also a valid way to discard the old source.
    try { await route.fulfill({ json: catalog(ALPHA) }); }
    catch (error) { if (!route.request().failure()) throw error; }
    finally { alphaSettled.resolve(); }
  });
  try {
    await openMain(page);
    await expect.poll(() => alphaRequested).toBe(true);
    await switchToArchive(page);
    await expectDesktopModels(page, BETA);
    alphaReady.resolve();
    await alphaSettled.promise;
    await expectDesktopModels(page, BETA, ALPHA);
  } finally { alphaReady.resolve(); }
});

test("new-project catalogs reset the previous draft model selection", async ({ page }) => {
  const betaReady = deferred();
  const projectCwds: string[] = [];
  // Git worktree discovery returns canonical paths. macOS temp fixtures can
  // begin as /var/... while the selected worktree is /private/var/....
  const projectCwd = realpathSync(process.env.E2E_PROJECT_CWD!);
  const worktreeCwd = realpathSync(path.join(path.dirname(projectCwd), "demo-project-wt"));
  await page.route(MODEL_API, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: catalog(ALPHA) });
    const body = route.request().postDataJSON() as { cwd: string };
    const cwd = realpathSync(body.cwd);
    projectCwds.push(cwd);
    if (cwd === worktreeCwd) {
      await betaReady.promise;
      return route.fulfill({ json: catalog(BETA, "fixture-beta") });
    }
    return route.fulfill({ json: catalog(ALPHA, "fixture-alpha", true) });
  });
  try {
    await openMain(page);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(trigger(page)).toHaveAttribute("data-catalog-status", "ready");
    await trigger(page).click();
    await page.getByRole("option", { name: new RegExp(ALTERNATE) }).click();
    await expect(trigger(page)).toContainText(ALTERNATE);
    await page.getByTestId("project-switcher-trigger").click();
    await page.getByTestId("worktree-row").filter({ hasText: "demo-project-wt" }).click();
    await expect(page.getByTestId("project-switcher-trigger")).toContainText("demo-project-wt");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(trigger(page)).toHaveAttribute("data-catalog-status", "loading");
    await expect(trigger(page)).not.toContainText(ALTERNATE);
    await trigger(page).click();
    await expect(recovery(page)).not.toContainText(ALPHA);
    await expect(recovery(page)).not.toContainText(ALTERNATE);
    await recovery(page).getByRole("button", { name: "Close", exact: true }).click();
    betaReady.resolve();
    await expect(trigger(page)).toContainText(BETA);
    await expectDesktopModels(page, BETA, ALTERNATE);
    expect(projectCwds).toContain(projectCwd);
    expect(projectCwds).toContain(worktreeCwd);
  } finally { betaReady.resolve(); }
});

test("runtime replacement SSE changes the catalog source without retaining old options", async ({ page }) => {
  const replace = deferred();
  const betaReady = deferred();
  const root = process.env.E2E_ROOT!;
  await page.route(new RegExp(`/api/sessions/${MAIN_ID}\\?includeState$`), async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, agentState: { running: true, state: { isStreaming: true } } } });
  });
  await page.route(new RegExp(`/api/agent/${MAIN_ID}/events(?:\\?|$)`), async (route: Route) => {
    await replace.promise;
    await route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({
      type: "session_replaced", previousSessionId: MAIN_ID, newSessionId: ARCHIVE_ID,
      cwd: path.join(root, "archive-project"),
      sessionFile: path.join(root, "agent", "sessions", "-archive", `2026-06-01T09-00-00_${ARCHIVE_ID}.jsonl`),
    })}\n\n` });
  });
  await page.route(MODEL_API, async (route) => {
    if (new URL(route.request().url()).searchParams.get("sessionId") === ARCHIVE_ID) {
      await betaReady.promise;
      return route.fulfill({ json: catalog(BETA, "fixture-beta") });
    }
    return route.fulfill({ json: catalog(ALPHA) });
  });
  try {
    await openMain(page, "Queue a follow-up…");
    await expect(trigger(page)).toHaveAttribute("data-catalog-status", "ready");
    replace.resolve();
    await expect(page).toHaveURL(new RegExp(`session=${ARCHIVE_ID}`));
    await expect(trigger(page)).toHaveAttribute("data-catalog-status", "loading");
    await expect(trigger(page)).toBeEnabled();
    await trigger(page).click();
    await expect(recovery(page)).not.toContainText(ALPHA);
    await recovery(page).getByRole("button", { name: "Close", exact: true }).click();
    betaReady.resolve();
    await expectDesktopModels(page, BETA, ALPHA);
  } finally { replace.resolve(); betaReady.resolve(); }
});

for (const style of ["original", "trae"] as const) {
  for (const width of [320, 390]) {
    test(`${style} ${width}px XL: recovery and Models actions remain visible and clickable`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((style) => {
        localStorage.setItem("pi-ui-style", style);
        localStorage.setItem("pi-skin", "trae");
        localStorage.setItem("pi-font-size", "xlarge");
      }, style);
      let attempts = 0;
      await page.route(MODEL_API, (route) => {
        attempts += 1;
        return route.fulfill({ status: 503, json: { error: "Fixture unavailable" } });
      });
      await openMain(page);
      if (style === "trae") await expect(page.locator("html")).toHaveAttribute("data-ui-style", "trae");
      else await expect(page.locator("html")).not.toHaveAttribute("data-ui-style", "trae");
      await expect(page.locator("html")).toHaveAttribute("data-font-size", "xlarge");
      await expect(trigger(page)).toHaveAttribute("data-catalog-status", "error");
      await expectWithinViewport(page, trigger(page));
      await trigger(page).click();
      await expectWithinViewport(page, recovery(page));
      const retry = page.getByTestId("model-catalog-retry");
      const configure = page.getByTestId("model-catalog-configure");
      await expectWithinViewport(page, retry);
      await expectWithinViewport(page, configure);
      const previousAttempts = attempts;
      await retry.click();
      await expect.poll(() => attempts).toBeGreaterThan(previousAttempts);
      await expect(recovery(page).getByRole("status")).toHaveText("Could not load models");
      await configure.click();
      const models = page.getByTestId("models-config-dialog");
      await expectWithinViewport(page, models);
      await expectWithinViewport(page, page.getByTestId("provider-health-nav"));
      await page.getByTestId("provider-health-nav").click();
      const health = page.getByTestId("provider-health");
      await expect(health).toContainText("No provider configured");
      const addProvider = health.getByRole("button", { name: "Add provider", exact: true });
      await addProvider.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, addProvider);
      await expect.poll(() => models.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const pageWidth = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      expect(pageWidth.document).toBeLessThanOrEqual(pageWidth.viewport);
      expect(pageWidth.body).toBeLessThanOrEqual(pageWidth.viewport);
      await models.screenshot({ path: test.info().outputPath(`model-recovery-${style}-${width}-xl.png`) });
      await models.getByRole("button", { name: "Close", exact: true }).click();
      await expect(trigger(page)).toBeVisible();
    });
  }
}
