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
    await composer.fill("My own draft");
    await page.reload();
    await expect(composer).toHaveValue("My own draft");
    await expect(hint).toBeHidden();
    await composer.fill("");
    await expect(hint).toBeVisible();
    await composer.focus(); await composer.press("Escape");
    await expect(hint).toBeHidden();
    await composer.press("Tab"); await expect(composer).not.toBeFocused();
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
