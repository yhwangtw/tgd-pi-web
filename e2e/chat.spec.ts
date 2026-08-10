import { test, expect, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
const FAILED = "/?session=eeee1111-2222-3333-4444-555566667777";

const scroller = (page: Page) => page.locator("div.flex-1.overflow-y-auto").first();

async function openMain(page: Page) {
  await page.goto(MAIN);
  // Sidebar session name — transcript text can be content-visibility-skipped
  // when offscreen, which Playwright reports as "hidden".
  await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Show full message/ }).first()).toBeAttached({ timeout: 10_000 });
}

test.describe("chat transcript", () => {
  test("offers Compact only after a session has been persisted", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "More composer controls" }).click();
    await expect(page.getByRole("button", { name: "Compact", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.locator("textarea").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Compact", exact: true })).toHaveCount(0);
  });

  test("shows and persists the Auto compact setting for a saved session", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "More composer controls" }).click();
    const toggle = page.getByRole("button", { name: /Auto compact/ });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    // Restore the fixture default so later specs are isolated.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  test("long history collapses behind a preview; latest turn stays expanded", async ({ page }) => {
    await openMain(page);
    const expand = page.getByRole("button", { name: /Show full message/ });
    await expect(expand.first()).toBeAttached();

    // Expand ↔ collapse round-trip
    await expand.first().scrollIntoViewIfNeeded();
    await expect(expand.first()).toBeVisible();
    const before = await expand.count();
    await expand.first().click();
    const collapse = page.getByRole("button", { name: /Collapse message/ });
    await expect(collapse.first()).toBeVisible();
    await collapse.first().click();
    await expect(expand).toHaveCount(before);

    // The latest message never collapses
    const lastCollapsed = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".msg-item")];
      const last = items[items.length - 1];
      return (last?.textContent ?? "").includes("Show full message");
    });
    expect(lastCollapsed).toBe(false);
  });

  test("⌥↑ / ⌥↓ walk between user turns", async ({ page }) => {
    await openMain(page);
    const el = scroller(page);
    await el.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.waitForTimeout(300);
    const atBottom = await el.evaluate((node) => node.scrollTop);

    await page.keyboard.press("Alt+ArrowUp");
    await page.waitForTimeout(700);
    const up1 = await el.evaluate((node) => node.scrollTop);
    await page.keyboard.press("Alt+ArrowUp");
    await page.waitForTimeout(700);
    const up2 = await el.evaluate((node) => node.scrollTop);
    expect(up1).toBeLessThan(atBottom);
    expect(up2).toBeLessThan(up1);

    await page.keyboard.press("Alt+ArrowDown");
    await page.waitForTimeout(700);
    const down = await el.evaluate((node) => node.scrollTop);
    expect(down).toBeGreaterThan(up2);
  });

  test("⌘F jump auto-expands a collapsed match", async ({ page }) => {
    await openMain(page);
    // A phrase that only lives deep inside the collapsed long message.
    // fill() the find input directly — keyboard.type races the rAF focus
    // on slow runners and drops leading characters.
    await page.keyboard.press("Control+f");
    const findInput = page.getByPlaceholder("Find in conversation…");
    await expect(findInput).toBeVisible();
    await findInput.fill("第 7 段詳細說明");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    // Attached, not visible: the expanded message is taller than the viewport
    // and its collapse control can sit below the fold (content-visibility
    // reports offscreen content as hidden).
    await expect(page.getByRole("button", { name: /Collapse message/ }).first()).toBeAttached({ timeout: 5_000 });
  });

  test("failed run shows the error card and a Retry action", async ({ page }) => {
    await page.goto(FAILED);
    await expect(page.getByText(/429 rate_limit_error/)).toBeAttached({ timeout: 20_000 });
    const retry = page.getByRole("button", { name: "Retry last run" });
    await expect(retry).toBeVisible();
    // Clicking must not crash the app (offline CI has no model — the send
    // itself may fail with a toast, which is fine).
    await retry.click();
    await page.waitForTimeout(1_500);
    // The app must stay alive whether the resend reached a model (local) or
    // failed instantly for lack of provider config (CI) — the composer
    // textarea exists in both states, though its placeholder differs.
    await expect(page.locator("textarea").first()).toBeVisible();
  });

  test("edit turns a past user message into an inline editor prefilled with its text", async ({ page }) => {
    await openMain(page);
    const userMsg = page.getByText("services 層有沒有需要重構的地方").first();
    await userMsg.scrollIntoViewIfNeeded();
    const messageItem = page.locator(".msg-item").filter({ has: userMsg }).first();
    await messageItem.getByRole("button", { name: "More message actions" }).click();
    await messageItem.getByRole("button", { name: "Edit", exact: true }).click();
    // The bubble becomes a textarea prefilled with the message text, plus Rerun.
    await expect
      .poll(async () => {
        for (const ta of await page.locator("textarea").all()) {
          if ((await ta.inputValue()).includes("services 層有沒有需要重構的地方")) return true;
        }
        return false;
      }, { timeout: 5_000 })
      .toBe(true);
    await expect(page.getByRole("button", { name: "Rerun" })).toBeVisible();
    // Cancel restores the read-only bubble
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Rerun" })).toHaveCount(0);
    await expect(page.getByText("services 層有沒有需要重構的地方").first()).toBeVisible();
  });

  test("assistant message actions use a discoverable menu attached to their footer", async ({ page }) => {
    await openMain(page);
    const message = page.getByTestId("assistant-message").last();
    await message.scrollIntoViewIfNeeded();

    const footer = message.getByTestId("assistant-message-footer");
    const menuButton = message.getByRole("button", { name: "More message actions" });
    await expect(menuButton).toBeVisible();

    const footerBox = await footer.boundingBox();
    const buttonBox = await menuButton.boundingBox();
    expect(footerBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    expect(buttonBox!.x).toBeGreaterThanOrEqual(footerBox!.x);
    expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(footerBox!.x + footerBox!.width + 1);

    await menuButton.click();
    await expect(message.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
    await expect(message.getByRole("button", { name: "Quote", exact: true })).toBeVisible();
    await expect(message.getByRole("button", { name: "Bookmark this message" })).toBeVisible();
  });

  test("turns expose semantic message articles inside a readable conversation column", async ({ page }) => {
    await openMain(page);
    const conversation = page.getByRole("log", { name: "Conversation" });
    await expect(conversation).toBeVisible();
    const articles = conversation.getByRole("article");
    expect(await articles.count()).toBeGreaterThan(1);
    await expect(articles.first()).toHaveAttribute("aria-label", /Your message.*Turns 1/);
    await expect(articles.first()).toHaveAttribute("data-turn-position", "start");

    const width = await conversation.evaluate((node) => node.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(781);
  });

  test("always-follow toggle persists via the palette", async ({ page }) => {
    await openMain(page);
    for (const round of ["on", "off"] as const) {
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(300);
      await page.keyboard.type("always-follow");
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      const stored = await page.evaluate(() => localStorage.getItem("pi-follow-stream"));
      expect(stored).toBe(round === "on" ? "1" : null);
    }
  });
});
