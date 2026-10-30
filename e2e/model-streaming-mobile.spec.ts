import { isFixtureReadReceipt } from "./read-receipt-fixture";
import { expect, test as base, type Locator, type Page } from "@playwright/test";

const MAIN_ID = "aaaa1111-2222-3333-4444-555566667777";
const MODEL_NAME = "Fixture Claude Sonnet streaming with a deliberately long model name";
const model = { provider: "anthropic", id: "claude-sonnet-5" };

const test = base.extend<{ streamingNetworkSafety: void }>({
  streamingNetworkSafety: [async ({ page }, use) => {
    const forbidden: string[] = [];
    await page.addInitScript(() => localStorage.setItem("pi-composer-hints", "off"));
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
      if (isFixtureReadReceipt(request)) return route.continue();
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

async function expectSingleLineLabel(button: Locator) {
  const text = await button.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = Array.from(range.getClientRects());
    const box = element.getBoundingClientRect();
    return {
      lines: new Set(rects.map(rect => Math.round(rect.y))).size,
      fits: rects.every(rect => rect.x >= box.x && rect.right <= box.right + 1 && rect.y >= box.y && rect.bottom <= box.bottom + 1),
    };
  });
  expect(text, "Delivery labels must remain fully visible on one line").toEqual({ lines: 1, fits: true });
}

async function expectComposerBorder(page: Page, token: string) {
  const composer = page.locator('[class*="innerWrapper"]').first();
  await expect.poll(() => composer.evaluate((element, token) => {
    const probe = document.createElement("span");
    probe.style.border = `1px solid var(${token})`;
    element.append(probe);
    const expected = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return getComputedStyle(element).borderTopColor === expected;
  }, token)).toBe(true);
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
      const composer = page.getByRole("textbox", { name: "Message…", exact: true });
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await expect(composer).toHaveAttribute("placeholder", "Queue a follow-up…");
      await expect.poll(snapshotsSent).toBeGreaterThan(0);
      await expect(page.getByText("Fixture stream is active; no provider was contacted.", { exact: true })).toBeAttached();
      await expect(page.locator("html")).toHaveAttribute("data-font-size", "xlarge");
      if (style === "trae") await expect(page.locator("html")).toHaveAttribute("data-ui-style", "trae");
      else await expect(page.locator("html")).not.toHaveAttribute("data-ui-style", "trae");

      const identity = page.getByTestId("model-selector-trigger");
      await expect(identity).toHaveAttribute("data-catalog-status", "ready");
      await expect(identity).toHaveAccessibleName(`Model: ${MODEL_NAME}`);
      await expect(identity).toContainText(MODEL_NAME);
      await expect(identity).toBeEnabled();
      await expectInsideViewport(page, identity);

      const delivery = page.getByRole("group", { name: "Message delivery mode", exact: true });
      const followUp = delivery.getByRole("button", { name: "Follow-up", exact: true });
      const steer = delivery.getByRole("button", { name: "Steer", exact: true });
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      for (const control of [followUp, steer, stop]) {
        await expect(control).toBeEnabled();
        await expectInsideViewport(page, control);
      }
      await expectSingleLineLabel(followUp);
      await expectSingleLineLabel(steer);
      // Mode switches are local UI actions. Keep a draft, but never submit it.
      const draft = "Fixture draft only — do not send.";
      await composer.fill(draft);
      const editingRoot = page.locator("[data-composer-editing]");
      await expect(editingRoot).toHaveAttribute("data-composer-editing", "true");
      const primaryNav = page.getByRole("navigation", { name: "Primary navigation", exact: true });
      await expect(primaryNav).not.toBeInViewport();
      await steer.click();
      await expect(steer).toHaveAttribute("aria-pressed", "true");
      await expect(composer).toHaveAttribute("placeholder", "Queue a steering message…");
      await expect(composer).toHaveValue(draft);
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
      await expect(composer).toHaveAttribute("placeholder", "Queue a steering message…");
      await expect(composer).toHaveValue(draft);
      await followUp.click();
      await expect(followUp).toHaveAttribute("aria-pressed", "true");
      await expect(composer).toBeFocused();
      await leaveComposerWithKeyboard(page);
      await page.screenshot({ path: test.info().outputPath(`streaming-nav-restored-${style}-${width}-xl.png`) });

      // Re-load a controlled idle
      // snapshot to cover their first clicks from outside without any real run.
      await installStreamingFixture(page, false);
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
      await expect(identity).toHaveAttribute("data-catalog-status", "ready");
      await expect(editingRoot).toHaveAttribute("data-composer-editing", "false");
      await expect(primaryNav).toBeInViewport();
      const attach = page.getByRole("button", { name: "Attach files", exact: true });
      const chooserPromise = page.waitForEvent("filechooser");
      await attach.click();
      const chooser = await chooserPromise;
      expect(chooser.isMultiple()).toBe(true); // no files are selected or read
      await expect(editingRoot).toHaveAttribute("data-composer-editing", "false");
      await expect(primaryNav).toBeInViewport();
      await identity.click();
      const modelSheet = page.getByRole("dialog", { name: "Choose a model", exact: true });
      await expectInsideViewport(page, modelSheet);
      await expect(modelSheet.getByRole("searchbox", { name: "Search models", exact: true })).toBeFocused();
      await expect(modelSheet.getByRole("button", { name: `${MODEL_NAME} anthropic Available 200k ctx`, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(modelSheet).not.toBeVisible();
      await expect(identity).toBeFocused();
      await expect(primaryNav).toBeInViewport();
    });
  }
}

for (const style of ["original", "trae"] as const) {
  test(`${style}: desktop delivery controls stay legible when the conversation narrows`, async ({ page }) => {
    await page.addInitScript(style => {
      localStorage.setItem("pi-locale", "en");
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-theme", "dark");
    }, style);
    await installStreamingFixture(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?session=${MAIN_ID}`);
    const composer = page.getByRole("textbox", { name: "Message…", exact: true });
    const delivery = page.getByRole("group", { name: "Message delivery mode", exact: true });
    const followUp = delivery.getByRole("button", { name: "Follow-up", exact: true });
    const steer = delivery.getByRole("button", { name: "Steer", exact: true });
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    const identity = page.getByTestId("model-selector-trigger");
    await expect(delivery).toBeVisible();
    await expectComposerBorder(page, "--border-subtle");
    await composer.fill("Keep this draft while switching modes");
    await expectComposerBorder(page, "--color-accent-border-focus");
    const followUpAction = page.getByRole("button", { name: "Queue until the current run finishes (Command+Enter)", exact: true });
    const actionColor = await followUpAction.evaluate(element => getComputedStyle(element).backgroundColor);
    await steer.click();
    await expect(steer).toHaveAttribute("aria-pressed", "true");
    const steerAction = page.getByRole("button", { name: "Queue for the next model call (Option+Enter)", exact: true });
    expect(await steerAction.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(actionColor);
    await expectComposerBorder(page, "--color-accent-border-focus");
    await followUp.click();
    for (const width of [1440, 1100, 840, 701]) {
      await page.setViewportSize({ width, height: 900 });
      for (const control of [followUp, steer, stop, identity]) await expectInsideViewport(page, control);
      await expectSingleLineLabel(followUp);
      await expectSingleLineLabel(steer);
      await stop.click({ trial: true });
      if (width >= 1100) {
        const [modeBox, stopBox] = await Promise.all([delivery.boundingBox(), stop.boundingBox()]);
        expect(Math.abs(modeBox!.y + modeBox!.height / 2 - stopBox!.y - stopBox!.height / 2), "Desktop Stop should share the delivery toolbar row").toBeLessThanOrEqual(1);
      }
      await expect(composer).toHaveValue("Keep this draft while switching modes");
      const bounds = await page.locator('[class*="bottomBarStreaming"]').evaluate(element => {
        const box = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll("button")).filter(button => button.getClientRects().length > 0)
          .every(button => { const rect = button.getBoundingClientRect(); return rect.x >= box.x - 1 && rect.right <= box.right + 1; });
      });
      expect(bounds, "Controls must stay inside the composer even with the sidebar open").toBe(true);
      await page.screenshot({ path: test.info().outputPath(`streaming-${style}-${width}.png`) });
    }
  });

  test(`${style}: session title and preview stay vertically centered at both densities and text sizes`, async ({ page }) => {
    await installStreamingFixture(page, false);
    for (const density of ["comfortable", "compact"]) {
      for (const fontSize of ["default", "xlarge"]) {
        await page.addInitScript(({ style, density, fontSize }) => {
          localStorage.setItem("pi-locale", "en");
          localStorage.setItem("pi-ui-style", style);
          localStorage.setItem("pi-density", density);
          localStorage.setItem("pi-font-size", fontSize);
        }, { style, density, fontSize });
        const row = page.locator(`[data-session-row="${MAIN_ID}"]`);
        for (const width of [1440, 390]) {
          // Mount in the target viewport: resizing an open desktop sidebar to
          // mobile retains its state, so blindly clicking Sessions closes it.
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`/?session=${MAIN_ID}`);
          await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
          if (width === 390) {
            await expect(page.locator(".sidebar-container")).toHaveAttribute("aria-hidden", "true");
            await page.getByRole("button", { name: "Sessions", exact: true }).click();
          }
          // The shared fixture store can contain many newer conversations.
          await page.getByRole("textbox", { name: "Search conversations", exact: true }).fill("專案架構分析");
          await expect(row).toHaveAttribute("aria-selected", "true");
          await expect(row).toBeVisible();
          await expect.poll(async () => {
            const box = await row.boundingBox();
            return !!box && box.x >= 0 && box.x + box.width <= width;
          }, { message: "Wait for the sidebar drawer to fully enter the viewport" }).toBe(true);
          const geometry = await row.evaluate(element => {
            const box = element.getBoundingClientRect();
            const content = element.querySelector('[role="gridcell"]')!.getBoundingClientRect();
            return { offset: Math.abs((content.top + content.bottom - box.top - box.bottom) / 2), fits: content.top >= box.top && content.bottom <= box.bottom };
          });
          expect(geometry.offset).toBeLessThanOrEqual(1);
          expect(geometry.fits).toBe(true);
          if (width === 1440) await row.screenshot({ path: test.info().outputPath(`session-row-${style}-${density}-${fontSize}.png`) });
        }
        await page.screenshot({ path: test.info().outputPath(`session-card-${style}-${density}-${fontSize}.png`) });
      }
    }
  });
}
