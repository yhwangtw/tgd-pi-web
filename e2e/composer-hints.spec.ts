import { test, expect } from "@playwright/test";

const MAIN = "/?session=ffff1111-2222-3333-4444-555566667777";
const OTHER = "/?session=aaaa1111-2222-3333-4444-555566667777";

for (const width of [320, 1440]) for (const locale of ["en", "zh"]) {
  test(`context suggestion ${width} ${locale}: accept, edit, dismiss, and opt out`, async ({ page }, info) => {
    const suggestion = locale === "zh" ? "幫我檢查剛修改的 clamp 在手機版預覽是否正常" : "Check the updated clamp function and preview it on mobile";
    let requests = 0;
    await page.addInitScript(locale => { localStorage.setItem("pi-locale", locale); }, locale);
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/composer-hint", async route => {
      requests++;
      const body = route.request().postDataJSON();
      expect(body.locale).toBe(locale);
      expect(body.messages.at(-1).role).toBe("assistant");
      expect(body.turnId).toContain("ffff1111-2222-3333-4444-555566667777:");
      expect(JSON.stringify(body.messages)).toContain("clamp");
      await route.fulfill({ json: { hint: suggestion } });
    });
    let sends = 0;
    page.on("request", request => { if (request.method() === "POST" && /\/api\/agent\/.*\/command/.test(request.url())) sends++; });
    await page.goto(MAIN);
    const composer = page.getByTestId("composer-shell").locator("textarea");
    const hint = page.getByTestId("composer-hint");
    await expect(hint).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(hint).toContainText(suggestion);
    expect(await hint.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`hint-${width}-${locale}.png`) });
    if (width === 320) await hint.click();
    else { await composer.focus(); await composer.press("Enter"); await expect(composer).toHaveValue(""); await composer.press("Tab"); }
    await expect(composer).toHaveValue(suggestion);
    await expect(hint).toBeHidden();
    expect(sends).toBe(0);
    await composer.fill("");
    await expect(hint).toBeVisible();
    expect(requests).toBe(1);
    await composer.fill("My own draft");
    await page.reload();
    await expect(composer).toHaveValue("My own draft");
    await expect(hint).toBeHidden();
    await composer.fill("");
    await expect(hint).toBeVisible();
    await composer.focus(); await composer.press("Escape");
    await expect(hint).toBeHidden();
    await composer.press("Tab"); await expect(composer).not.toBeFocused();
    await composer.fill("A new draft after dismissing"); await composer.fill("");
    await expect(hint).toBeVisible(); expect(requests).toBe(2); // Reload had its own browser cache.
    await page.getByRole("button", { name: locale === "zh" ? "更多輸入框設定" : "More composer controls", exact: true }).click();
    const toggle = page.getByRole("button", { name: locale === "zh" ? "對話輸入建議" : "Contextual suggestions", exact: true });
    await toggle.click(); await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const previousRequests = requests;
    await page.reload(); await expect(composer).toBeVisible();
    await page.waitForTimeout(900);
    await expect(hint).toBeHidden(); expect(requests).toBe(previousRequests);
  });
}

test("late or failed suggestions never appear in a different session", async ({ page }) => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/composer-hint", async route => {
    const context = JSON.stringify(route.request().postDataJSON().messages);
    if (context.includes("clamp")) { await waiting; await route.fulfill({ json: { hint: "Old session suggestion" } }); }
    else await route.fulfill({ status: 503, json: { hint: null } });
  });
  await page.goto(MAIN);
  await page.waitForRequest("**/api/composer-hint");
  await page.goto(OTHER);
  release();
  const composer = page.getByTestId("composer-shell").locator("textarea");
  await expect(composer).toBeVisible();
  await page.waitForTimeout(900);
  await expect(page.getByTestId("composer-hint")).toBeHidden();
  await composer.fill("Continue normally"); await expect(composer).toHaveValue("Continue normally");
});

for (const width of [320, 1440]) for (const failure of ["empty", "network"]) {
  test(`${width} ${failure}: retries without refresh and restores a cleared adopted draft`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let requests = 0;
    await page.route("**/api/composer-hint", async route => {
      requests++;
      if (requests === 1) {
        await route.fulfill({ status: failure === "network" ? 503 : 200,
          json: { hint: null, status: "empty", retryable: true, retryAfterMs: 2000 } });
      } else await route.fulfill({ json: { hint: "幫我驗證手機版檔案預覽" } });
    });
    await page.goto(MAIN);
    const composer = page.getByTestId("composer-shell").locator("textarea");
    const hint = page.getByTestId("composer-hint");
    await expect(hint).toBeVisible({ timeout: 10_000 });
    expect(requests).toBe(2);
    await hint.click(); await expect(composer).toHaveValue("幫我驗證手機版檔案預覽");
    await composer.fill(""); await expect(hint).toBeVisible();
    await composer.fill("Keep my draft"); await page.waitForTimeout(800);
    await expect(hint).toBeHidden(); await expect(composer).toHaveValue("Keep my draft");
    await composer.fill(""); await expect(hint).toBeVisible();
    expect(requests).toBe(2);
    await page.screenshot({ path: info.outputPath(`restored-${width}-${failure}.png`) });
  });
}

test("empty output stops after three attempts and does not consume the next session's retry budget", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/composer-hint", async route => {
    requests++;
    const context = JSON.stringify(route.request().postDataJSON().messages);
    await route.fulfill({ json: context.includes("clamp")
      ? { hint: null, status: "empty", retryable: true, retryAfterMs: 2000 }
      : { hint: "Check the next refactoring step" } });
  });
  await page.goto(MAIN);
  await expect.poll(() => requests, { timeout: 12_000 }).toBe(3);
  await page.waitForTimeout(4500); expect(requests).toBe(3);
  await expect(page.getByTestId("composer-hint")).toBeHidden();
  await page.goto(OTHER);
  await expect(page.getByTestId("composer-hint")).toBeVisible();
  expect(requests).toBe(4);
});

test("typing pauses an empty-result retry until the draft is cleared", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/composer-hint", async route => {
    requests++;
    await route.fulfill({ json: { hint: requests === 1 ? null : "Resume verification" } });
  });
  const first = page.waitForResponse("**/api/composer-hint");
  await page.goto(MAIN); await first;
  const composer = page.getByTestId("composer-shell").locator("textarea");
  await composer.fill("Do not touch this draft");
  await page.waitForTimeout(2500); expect(requests).toBe(1);
  await expect(composer).toHaveValue("Do not touch this draft");
  await composer.fill(""); await expect(page.getByTestId("composer-hint")).toBeVisible();
  expect(requests).toBe(2);
});

for (const locale of ["en", "zh"]) {
  test(`${locale}: never displays an assistant-voice prediction as the user's prompt`, async ({ page }) => {
    await page.addInitScript(locale => localStorage.setItem("pi-locale", locale), locale);
    const wrong = locale === "zh" ? "我會先測試手機版。" : "I'll test the mobile layout.";
    const correct = locale === "zh" ? "幫我驗證手機版的排版。" : "Can you verify the mobile layout?";
    let calls = 0;
    await page.route("**/api/composer-hint", async route => {
      calls++;
      await route.fulfill({ json: { hint: calls === 1 ? wrong : correct } });
    });
    const first = page.waitForResponse("**/api/composer-hint");
    await page.goto(MAIN); await first;
    const hint = page.getByTestId("composer-hint");
    await expect(hint).toBeHidden();
    await expect(hint).toBeVisible({ timeout: 8000 });
    await expect(hint).toContainText(correct); await expect(hint).not.toContainText(wrong);
    expect(calls).toBe(2);
    const composer = page.getByTestId("composer-shell").locator("textarea");
    await composer.focus(); await composer.press("Tab"); await expect(composer).toHaveValue(correct);
    await composer.fill(""); await expect(hint).toContainText(correct); expect(calls).toBe(2);
  });
}
