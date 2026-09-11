import { expect, test as base, type Locator, type Page } from "@playwright/test";

const MAIN_ID = "aaaa1111-2222-3333-4444-555566667777";
const MODEL_NAME = "Fixture Claude Sonnet streaming";
const model = { provider: "anthropic", id: "claude-sonnet-5" };

const test = base.extend<{ streamingNetworkSafety: void }>({
  streamingNetworkSafety: [async ({ page }, use) => {
    const forbidden: string[] = [];
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (["GET", "HEAD"].includes(request.method())) return route.continue();
      let body: Record<string, unknown> | undefined;
      try { body = request.postDataJSON(); } catch { /* Invalid mutation bodies stay blocked. */ }
      // Batch worktree identities are read-only; action-shaped bodies are not.
      if (request.method() === "POST" && pathname === "/api/worktrees" && body
        && Object.keys(body).length === 1 && Array.isArray(body.cwds) && body.cwds.length <= 128
        && body.cwds.every((cwd) => typeof cwd === "string" && cwd.length > 0)) return route.continue();
      if (request.method() === "POST" && /^\/api\/agent\/[^/]+$/.test(pathname) && body?.type === "get_tools") {
        return route.fulfill({ json: { success: true, data: [] } });
      }
      forbidden.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 403, json: { error: "Streaming layout E2E forbids model calls and mutations" } });
    });
    await use();
    expect(forbidden, "Layout interactions must never send a prompt, steer, abort, or persistent mutation").toEqual([]);
  }, { auto: true }],
});

async function installStreamingFixture(page: Page, running = true) {
  let snapshotsSent = 0;
  await page.route(/\/api\/models(?:\?|$)/, (route) => route.request().method() === "GET"
    ? route.fulfill({ json: {
      modelList: [{ ...model, name: MODEL_NAME, available: true, contextWindow: 200_000, maxTokens: 8_192 }],
      defaultModel: { provider: model.provider, modelId: model.id }, thinkingLevels: {}, thinkingLevelMaps: {},
    } }) : route.fallback());
  await page.route(new RegExp(`/api/sessions/${MAIN_ID}\\?includeState$`), async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: {
      ...data,
      agentState: { running, state: { isStreaming: running, model } },
    } });
  });
  await page.route(new RegExp(`/api/agent/${MAIN_ID}/events(?:\\?|$)`), async (route) => {
    snapshotsSent += 1;
    // Match AgentSessionWrapper.getStreamSnapshot: sessionId is mandatory for
    // the client's source guard. A transport reconnect receives another
    // snapshot, never a real agent call.
    const snapshot = {
      type: "session_snapshot", protocolVersion: 1, sessionId: MAIN_ID, replayStatus: "initial",
      state: { sessionId: MAIN_ID, isStreaming: running, model, isCompacting: false, thinkingLevel: "off" },
      phase: { kind: running ? "waiting_model" : "idle" },
      bashRun: null, lastRunError: null,
      streamingMessage: running ? {
        role: "assistant", provider: model.provider, model: model.id,
        timestamp: 1_757_203_200_000,
        content: [{ type: "text", text: "Fixture stream is active; no provider was contacted." }],
      } : null,
    };
    const connected = { type: "connected", sessionId: MAIN_ID };
    await route.fulfill({ contentType: "text/event-stream", body: `retry: 60000\ndata: ${JSON.stringify(connected)}\n\ndata: ${JSON.stringify(snapshot)}\n\n` });
  });
  return () => snapshotsSent;
}

async function expectInsideViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  await expect(locator).toBeInViewport();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function leaveComposerWithKeyboard(page: Page) {
  const root = page.locator("[data-composer-editing]");
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press("Shift+Tab");
    if (await root.evaluate((element) => !element.contains(document.activeElement))) break;
  }
  await expect(root).toHaveAttribute("data-composer-editing", "false");
  await expect(page.getByRole("navigation", { name: "Primary navigation", exact: true })).toBeInViewport();
}

for (const style of ["original", "trae"] as const) {
  for (const width of [320, 390]) {
    test(`${style} ${width}px XL: streaming retains model identity and reachable delivery controls`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((style) => {
        localStorage.setItem("pi-locale", "en");
        localStorage.setItem("pi-ui-style", style);
        localStorage.setItem("pi-skin", "trae");
        localStorage.setItem("pi-font-size", "xlarge");
      }, style);
      const snapshotsSent = await installStreamingFixture(page);
      await page.goto(`/?session=${MAIN_ID}`);
      const composer = page.getByRole("textbox", { name: "Queue a follow-up…", exact: true });
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await expect.poll(snapshotsSent).toBeGreaterThan(0);
      await expect(page.getByText("Fixture stream is active; no provider was contacted.", { exact: true })).toBeAttached();
      await expect(page.locator("html")).toHaveAttribute("data-font-size", "xlarge");
      if (style === "trae") await expect(page.locator("html")).toHaveAttribute("data-ui-style", "trae");
      else await expect(page.locator("html")).not.toHaveAttribute("data-ui-style", "trae");

      const identity = page.getByTestId("model-selector-trigger");
      await expect(identity).toHaveAttribute("data-catalog-status", "ready");
      await expect(identity).toHaveAccessibleName(`Model: ${MODEL_NAME}`);
      await expect(identity).toContainText(MODEL_NAME);
      await expect(identity).toBeDisabled();
      await expectInsideViewport(page, identity);

      const delivery = page.getByRole("group", { name: "Message delivery mode", exact: true });
      const followUp = delivery.getByRole("button", { name: "Follow-up", exact: true });
      const steer = delivery.getByRole("button", { name: "Steer", exact: true });
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      for (const control of [followUp, steer, stop]) {
        await expect(control).toBeEnabled();
        await expectInsideViewport(page, control);
      }
      // Mode switches are local UI actions. Keep a draft, but never submit it.
      const draft = "Fixture draft only — do not send.";
      await composer.fill(draft);
      const editingRoot = page.locator("[data-composer-editing]");
      await expect(editingRoot).toHaveAttribute("data-composer-editing", "true");
      const primaryNav = page.getByRole("navigation", { name: "Primary navigation", exact: true });
      await expect(primaryNav).not.toBeInViewport();
      await steer.click();
      await expect(steer).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("textbox", { name: "Steer the current run…", exact: true })).toHaveValue(draft);
      await followUp.click();
      await expect(followUp).toHaveAttribute("aria-pressed", "true");
      await expect(composer).toHaveValue(draft);
      // Trial checks hit-target/actionability without dispatching an abort.
      await stop.click({ trial: true });
      for (const control of [identity, followUp, steer, stop]) await expectInsideViewport(page, control);
      const dimensions = await page.evaluate(() => ({
        viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      }));
      expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
      expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
      await page.screenshot({ path: test.info().outputPath(`streaming-model-${style}-${width}-xl.png`) });

      // A real keyboard exit restores navigation. The next pointer click from
      // outside must still reach Steer before editing hides that navigation.
      await expect(composer).toBeFocused();
      await leaveComposerWithKeyboard(page);
      await steer.click();
      await expect(steer).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("textbox", { name: "Steer the current run…", exact: true })).toHaveValue(draft);
      await followUp.click();
      await expect(followUp).toHaveAttribute("aria-pressed", "true");
      await expect(composer).toBeFocused();
      await leaveComposerWithKeyboard(page);
      await page.screenshot({ path: test.info().outputPath(`streaming-nav-restored-${style}-${width}-xl.png`) });

      // Attach / Models are disabled while streaming. Re-load a controlled idle
      // snapshot to cover their first clicks from outside without any real run.
      await installStreamingFixture(page, false);
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
      await expect(identity).toHaveAttribute("data-catalog-status", "ready");
      await expect(editingRoot).toHaveAttribute("data-composer-editing", "false");
      await expect(primaryNav).toBeInViewport();
      const attach = page.getByRole("button", { name: "Attach image", exact: true });
      const chooserPromise = page.waitForEvent("filechooser");
      await attach.click();
      const chooser = await chooserPromise;
      expect(chooser.isMultiple()).toBe(true); // no files are selected or read
      await expect(editingRoot).toHaveAttribute("data-composer-editing", "false");
      await expect(primaryNav).toBeInViewport();
      await identity.click();
      await expect(page.getByRole("listbox", { name: "Model", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox", { name: "Model", exact: true })).not.toBeVisible();
      await expect(primaryNav).toBeInViewport();
    });
  }
}
