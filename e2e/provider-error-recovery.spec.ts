import { expect, test, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  // Let in-flight fixture reads finish before Playwright disposes responses.
  await page.unrouteAll({ behavior: "wait" });
});

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
const reasoningError = '400: {"message":"reasoning_effort `none` is not supported by this model Request id: fixture-request-123","type":"invalid_request_error","param":null}';
const rejectedError = "The 'fixture-spark' model is not supported when using Codex with a ChatGPT account";

async function installFailure(page: Page, rejected = false) {
  const modelId = rejected ? "fixture-spark" : "fixture-reasoning";
  const error = rejected ? rejectedError : reasoningError;
  const provider = "fixture";
  const failed = { role: "assistant", provider, model: modelId, content: [], stopReason: "error", errorMessage: error, timestamp: 1_780_000_000_000 };
  const messages = [{ role: "user", content: "Hello", timestamp: 1_780_000_000_000 }, failed];
  const forbidden: string[] = [];
  let thinkingLevel = "low";
  // No user data, credentials, or real provider request is used by this spec.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (["GET", "HEAD"].includes(request.method())) return route.continue();
    const body = request.postDataJSON();
    if (pathname === "/api/worktrees" && Array.isArray(body?.cwds) && Object.keys(body).length === 1) return route.continue();
    if (pathname.endsWith("/summarize")) return route.fulfill({ json: {} });
    if (pathname === `/api/agent/${SESSION}` && body?.type === "get_tools") return route.fulfill({ json: { success: true, data: [] } });
    if (pathname === `/api/agent/${SESSION}` && body?.type === "set_thinking_level" && body.level === "max") {
      thinkingLevel = "max";
      return route.fulfill({ json: { success: true, data: null } });
    }
    forbidden.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 403, json: { error: "Fixture forbids model requests and persistent changes" } });
  });
  await page.route(/\/api\/models(?:\?|$)/, (route) => route.fulfill({ json: {
    modelList: [
      { id: modelId, provider, name: rejected ? "Fixture Spark" : "Fixture reasoning model", available: true },
      { id: "fixture-alternate", provider, name: "Fixture alternate", available: true },
    ],
    defaultModel: { provider, modelId },
    thinkingLevels: { [`${provider}:${modelId}`]: ["low", "medium", "high", "xhigh", "max"] },
    thinkingLevelMaps: { [`${provider}:${modelId}`]: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  } }));
  await page.route(new RegExp(`/api/sessions/${SESSION}(?:\\?includeState)?$`), async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: {
      ...data, info: { ...data.info, name: "Provider recovery fixture" },
      context: { ...data.context, messages, entryIds: ["fixture-user", "fixture-error"], model: { provider, modelId }, thinkingLevel },
      agentState: { running: true, state: { isStreaming: false, thinkingLevel, model: { provider, id: modelId } } },
    } });
  });
  await page.route(new RegExp(`/api/agent/${SESSION}/events(?:\\?|$)`), (route) => {
    const events = [
      { type: "connected", sessionId: SESSION },
      { type: "session_snapshot", sessionId: SESSION, state: { isStreaming: false, thinkingLevel: "low", model: { provider, id: modelId } }, lastRunError: error },
      { type: "agent_end", messages: [failed] },
    ];
    return route.fulfill({ contentType: "text/event-stream", body: `retry: 60000\n${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}` });
  });
  return forbidden;
}

for (const style of ["original", "trae"] as const) {
  for (const width of [320, 390, 1440]) {
    test(`${style} ${width}px: one concise error with inline recovery and reachable thinking controls`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(({ style, width }) => {
        localStorage.setItem("pi-locale", "en");
        localStorage.setItem("pi-ui-style", style);
        localStorage.setItem("pi-font-size", width === 320 ? "xlarge" : "default");
      }, { style, width });
      const forbidden = await installFailure(page);
      await page.goto(`/?session=${SESSION}`);
      const error = page.getByRole("alert").filter({ hasText: "This model does not support the selected thinking level." });
      await expect(error).toHaveCount(1);
      await error.scrollIntoViewIfNeeded();
      await expect(error).toBeVisible();
      const details = error.locator("details");
      await expect(details).not.toHaveAttribute("open");
      await expect(details.locator("div")).toBeHidden();
      await expect(page.getByRole("checkbox", { name: /Automatically try/ })).toHaveCount(0);
      const recovery = page.getByRole("region", { name: "Recovery options" });
      await expect(recovery).toBeVisible();
      await expect(recovery).not.toContainText("reasoning_effort");
      await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeEditable();
      await recovery.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`recovery-${style}-${width}.png`) });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      await recovery.getByRole("button", { name: "Adjust thinking" }).click();
      await page.getByRole("button", { name: "Change reasoning level", exact: true }).click();
      const levels = page.getByRole("listbox", { name: "Change reasoning level" });
      await expect(levels.getByRole("option", { name: /^Low/ })).toBeVisible();
      await expect(levels.getByRole("option", { name: /^(Off|Minimal)/ })).toHaveCount(0);
      const max = levels.getByRole("option", { name: /^Max/ });
      await max.scrollIntoViewIfNeeded();
      await expect(max).toBeInViewport();
      const overlappingLabels = await levels.getByRole("option").evaluateAll((options) => options.flatMap((option) => {
        const label = option.querySelector('[class*="optionLabel"]');
        const description = option.querySelector('[class*="description"]');
        if (!label || !description) throw new Error("Thinking option must have a label and description");
        // Text ranges catch overflowing glyphs even when flex item boxes do not overlap.
        const labelRange = document.createRange();
        const descriptionRange = document.createRange();
        labelRange.selectNodeContents(label);
        descriptionRange.selectNodeContents(description);
        const a = labelRange.getBoundingClientRect();
        const b = descriptionRange.getBoundingClientRect();
        const overlaps = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
        return overlaps ? [label.textContent] : [];
      }));
      expect(overlappingLabels).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`thinking-${style}-${width}.png`) });
      await max.click();
      await expect(page.getByRole("button", { name: "Change reasoning level", exact: true })).toContainText("max");
      expect(forbidden).toEqual([]);
    });
  }
}

for (const width of [390, 1440]) {
  test(`${width}px: rejected model is disabled until an explicit catalog refresh`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
    const forbidden = await installFailure(page, true);
    await page.goto(`/?session=${SESSION}`);
    await expect(page.getByRole("alert").filter({ hasText: "This model was rejected for the current connection." })).toHaveCount(1);
    await page.getByTestId("model-selector-trigger").click();
    const model = width < 700 ? page.getByRole("button", { name: /Fixture Spark.*Unavailable/ }) : page.getByRole("option", { name: /Fixture Spark.*Unavailable/ });
    await expect(model).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("button", { name: "Refresh model availability" }).click();
    await page.getByTestId("model-selector-trigger").click();
    const refreshed = width < 700 ? page.getByRole("button", { name: /Fixture Spark.*Available/ }) : page.getByRole("option", { name: /Fixture Spark/ });
    await expect(refreshed).not.toHaveAttribute("aria-disabled", "true");
    expect(forbidden).toEqual([]);
  });
}
