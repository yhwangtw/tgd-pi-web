import { test, expect, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

async function openMain(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
}

test.describe("appearance", () => {
  test("picker panel: interface and color switch independently", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "Appearance" }).click();
    const dialog = page.getByRole("dialog", { name: "Appearance" });
    await expect(dialog).toBeVisible();

    const colors = dialog.getByRole("group", { name: "Color palette" });
    const rows = colors.getByRole("button");
    await expect(rows).toHaveCount(6);

    await dialog.getByRole("button", { name: "Original", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.hasAttribute("data-ui-style")))
      .toBe(false);

    await dialog.getByRole("button", { name: /Glass/ }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-skin")))
      .toBe("glass");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.hasAttribute("data-ui-style")))
      .toBe(false);

    await dialog.getByRole("button", { name: "TRAE", exact: true }).click();
    const combined = await page.evaluate(() => ({
      style: document.documentElement.getAttribute("data-ui-style"),
      skin: document.documentElement.getAttribute("data-skin"),
    }));
    expect(combined).toEqual({ style: "trae", skin: "glass" });
    await expect(dialog).toBeVisible(); // stays open for live preview

    await dialog.getByRole("button", { name: "Dark" }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("interface + skin + theme survive a reload via the no-flash init script", async ({ page }) => {
    await openMain(page);
    await page.evaluate(() => {
      localStorage.setItem("pi-skin", "glass");
      localStorage.setItem("pi-ui-style", "trae");
      localStorage.setItem("pi-theme", "dark");
    });
    await page.reload();
    await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
    const state = await page.evaluate(() => ({
      skin: document.documentElement.getAttribute("data-skin"),
      style: document.documentElement.getAttribute("data-ui-style"),
      dark: document.documentElement.classList.contains("dark"),
    }));
    expect(state).toEqual({ skin: "glass", style: "trae", dark: true });
  });

  test("message layout switches between split and all-left and survives reload", async ({ page }) => {
    await openMain(page);
    const userMessage = page.getByTestId("user-message-row").first();
    const splitBox = await userMessage.boundingBox();
    expect(splitBox).not.toBeNull();

    await page.getByRole("button", { name: "Appearance" }).click();
    const dialog = page.getByRole("dialog", { name: "Appearance" });
    await dialog.getByRole("button", { name: "All left" }).click();

    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-message-layout")))
      .toBe("left");
    const leftBox = await userMessage.boundingBox();
    expect(leftBox).not.toBeNull();
    expect(leftBox!.x).toBeLessThan(splitBox!.x);

    await page.reload();
    await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-message-layout")))
      .toBe("left");

    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("dialog", { name: "Appearance" }).getByRole("button", { name: "Left & right" }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.hasAttribute("data-message-layout")))
      .toBe(false);
  });

  test("interface density applies immediately and survives reload", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "Appearance" }).click();
    const dialog = page.getByRole("dialog", { name: "Appearance" });
    await dialog.getByRole("button", { name: "Compact", exact: true }).click();

    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-density")))
      .toBe("compact");

    await page.reload();
    await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-density")))
      .toBe("compact");

    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("dialog", { name: "Appearance" }).getByRole("button", { name: "Comfortable", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.hasAttribute("data-density")))
      .toBe(false);
  });

  test("all-left layout remains aligned and usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMain(page);

    const row = page.getByTestId("user-message-row").first();
    const splitBox = await row.boundingBox();
    expect(splitBox).not.toBeNull();

    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Appearance" });
    const leftButton = dialog.getByRole("button", { name: "All left" });
    await expect(leftButton).toBeVisible();
    expect((await leftButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await leftButton.click();
    await page.keyboard.press("Escape");

    const leftBox = await row.boundingBox();
    expect(leftBox).not.toBeNull();
    expect(leftBox!.x).toBeLessThan(splitBox!.x);

    const userMessage = page.getByTestId("user-message").first();
    await userMessage.getByRole("button", { name: "More message actions" }).click();
    const actions = userMessage.getByTestId("user-message-actions");
    await expect(actions).toBeVisible();
    const actionsBox = await actions.boundingBox();
    expect(actionsBox).not.toBeNull();
    expect(actionsBox!.x).toBeGreaterThanOrEqual(0);
    expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(390);
  });

  test("default is TRAE interface with TRAE violet colors", async ({ page }) => {
    await openMain(page);
    const state = await page.evaluate(() => ({
      skin: document.documentElement.getAttribute("data-skin"),
      style: document.documentElement.getAttribute("data-ui-style"),
      dark: document.documentElement.classList.contains("dark"),
    }));
    expect(state).toEqual({ skin: "trae", style: "trae", dark: false });
  });

  test("preserves an existing explicit Editorial choice", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("pi-skin", "editorial"));
    await openMain(page);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-skin")))
      .toBe("editorial");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.hasAttribute("data-ui-style")))
      .toBe(false);
  });

  test("primary empty-state actions keep readable contrast in every skin", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "Schedules", exact: true }).click();
    const create = page.getByRole("button", { name: "New schedule", exact: true });
    await expect(create).toBeVisible();

    for (const skin of ["trae", "terminal", "industrial", "aurora", "editorial", "glass"]) {
      for (const dark of [false, true]) {
        const contrast = await create.evaluate((button, state) => {
          const root = document.documentElement;
          if (state.skin === "terminal") root.removeAttribute("data-skin");
          else root.setAttribute("data-skin", state.skin);
          root.classList.toggle("dark", state.dark);

          const parse = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
          const luminance = (value: string) => {
            const channels = parse(value).map((channel) => {
              const normalized = channel / 255;
              return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
            });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
          };

          const styles = getComputedStyle(button);
          const foreground = luminance(styles.color);
          const background = luminance(styles.backgroundColor);
          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        }, { skin, dark });

        expect(contrast, `${skin} ${dark ? "dark" : "light"}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("schedule frequency exposes the selected option", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "Schedules", exact: true }).click();
    await page.getByRole("button", { name: "New schedule", exact: true }).first().click();
    const editor = page.getByTestId("schedule-editor");
    const once = editor.getByRole("button", { name: "Once", exact: true });
    const daily = editor.getByRole("button", { name: "Daily", exact: true });
    await expect(once).toHaveAttribute("aria-pressed", "false");
    await expect(daily).toHaveAttribute("aria-pressed", "true");
    await once.click();
    await expect(once).toHaveAttribute("aria-pressed", "true");
    await expect(daily).toHaveAttribute("aria-pressed", "false");
  });

  test("shared geometry and status tokens resolve in every skin and theme", async ({ page }) => {
    await openMain(page);

    for (const skin of ["trae", "terminal", "industrial", "aurora", "editorial", "glass"]) {
      for (const dark of [false, true]) {
        const tokens = await page.evaluate(({ skin, dark }) => {
          const root = document.documentElement;
          if (skin === "terminal") root.removeAttribute("data-skin");
          else root.setAttribute("data-skin", skin);
          root.classList.toggle("dark", dark);
          const styles = getComputedStyle(root);
          return {
            borderStrong: styles.getPropertyValue("--border-strong").trim(),
            borderSubtle: styles.getPropertyValue("--border-subtle").trim(),
            warning: styles.getPropertyValue("--color-warning").trim(),
            info: styles.getPropertyValue("--color-info").trim(),
            infoBg: styles.getPropertyValue("--color-info-bg").trim(),
            accentFg: styles.getPropertyValue("--color-accent-fg").trim(),
          };
        }, { skin, dark });

        expect(tokens, `${skin} ${dark ? "dark" : "light"}`).toEqual({
          borderStrong: expect.not.stringMatching(/^$/),
          borderSubtle: expect.not.stringMatching(/^$/),
          warning: expect.not.stringMatching(/^$/),
          info: expect.not.stringMatching(/^$/),
          infoBg: expect.not.stringMatching(/^$/),
          accentFg: expect.not.stringMatching(/^$/),
        });
      }
    }
  });
});
