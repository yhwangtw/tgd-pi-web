import { expect, test, type Locator, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
const skins = ["terminal", "trae", "industrial", "aurora", "editorial", "glass"];

async function openSessions(page: Page, width: number, style: string) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript((value) => {
    localStorage.setItem("pi-ui-style", value);
    localStorage.setItem("pi-locale", "en");
  }, style);
  await page.goto(MAIN);
  await expect(page.getByRole("textbox", { name: "Message…" })).toBeVisible();
  if (width <= 700) await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await expect(page.locator('[data-session-row][aria-selected="true"] time')).toBeVisible();
}

async function metadataContrast(page: Page, target: Locator, glass: boolean, label: string) {
  const colors = await target.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    const parse = (value: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    };
    const backgrounds: number[][] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const styles = getComputedStyle(node);
      if (Number(styles.opacity) !== 1) throw new Error("Metadata unexpectedly inherits opacity");
      const background = parse(styles.backgroundColor);
      backgrounds.push(background);
      if (background[3] === 255) break;
    }
    let background = [255, 255, 255];
    for (const layer of backgrounds.reverse()) {
      const alpha = layer[3] / 255;
      background = background.map((channel, index) => layer[index] * alpha + channel * (1 - alpha));
    }
    return { foreground: parse(getComputedStyle(element).color).slice(0, 3), background };
  });

  // Glass uses the real rendered gradient and stacked translucent surfaces.
  // Hide only glyphs in the crop so antialiasing cannot be mistaken for background.
  const screenshot = glass ? await target.screenshot({
    path: test.info().outputPath(`${label}-background.png`),
    animations: "disabled",
    style: "[data-session-row] time { color: transparent !important; text-shadow: none !important; }",
  }) : null;
  return page.evaluate(async ({ colors, screenshot }) => {
    const luminance = (channels: number[]) => channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const ratio = (background: number[]) => {
      const [hi, lo] = [luminance(colors.foreground), luminance(background)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    };
    if (!screenshot) return ratio(colors.background);
    const image = new Image();
    image.src = `data:image/png;base64,${screenshot}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
    let minimum = Infinity;
    for (let i = 0; i < pixels.length; i += 4) minimum = Math.min(minimum, ratio([pixels[i], pixels[i + 1], pixels[i + 2]]));
    return minimum;
  }, { colors, screenshot: screenshot?.toString("base64") ?? null });
}

for (const width of [390, 840, 1440]) for (const style of ["original", "trae"]) {
  test(`${style} ${width}px: selected and unselected metadata remain readable in all palettes`, async ({ page }) => {
    test.setTimeout(90_000);
    await openSessions(page, width, style);
    const selected = page.locator('[data-session-row][aria-selected="true"] time').first();
    const unselected = page.locator('[data-session-row][aria-selected="false"] time').first();
    for (const skin of skins) for (const dark of [false, true]) {
      await page.evaluate(async ({ skin, dark }) => {
        const root = document.documentElement;
        if (skin === "terminal") root.removeAttribute("data-skin"); else root.dataset.skin = skin;
        root.classList.toggle("dark", dark);
        // Let real background transitions settle before measuring their final state.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished.catch(() => {})));
      }, { skin, dark });
      for (const [state, target] of [["selected", selected], ["unselected", unselected]] as const) {
        const label = `${skin}-${dark ? "dark" : "light"}-${state}`;
        const ratio = await metadataContrast(page, target, skin === "glass", label);
        if (ratio < 4.5) await page.screenshot({ path: test.info().outputPath(`${label}-failure.png`) });
        expect(Number.isFinite(ratio)).toBe(true);
        expect(ratio, `${skin}/${dark ? "dark" : "light"}/${state}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    await expect(page.locator("html")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({ path: test.info().outputPath(`readability-${style}-${width}.png`) });
  });
}

for (const width of [390, 1440]) {
  test(`${width}px: reduced motion removes movement without adding global fades`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openSessions(page, width, "trae");
    const motion = await page.evaluate(() => {
      const panel = getComputedStyle(document.querySelector(".sidebar-container")!);
      const metadata = getComputedStyle(document.querySelector("[data-session-row] time")!);
      const action = getComputedStyle(document.querySelector('[data-session-row] button[aria-haspopup="menu"]')!);
      return { panelDuration: panel.transitionDuration, metadataDuration: metadata.transitionDuration, actionDuration: action.transitionDuration };
    });
    expect(motion.panelDuration.split(",").every((duration) => parseFloat(duration) === 0)).toBe(true);
    expect(motion.metadataDuration).toBe("0s");
    expect(motion.actionDuration.split(",").some((duration) => parseFloat(duration) > 0)).toBe(true);

    await page.getByRole("button", { name: width <= 700 ? "Chat" : "Sessions", exact: true }).click();
    await expect(page.locator(".sidebar-container")).toHaveClass(/sidebar-closed/);
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await expect(page.locator('[data-session-row][aria-selected="true"] time')).toBeVisible();

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(() => page.locator(".sidebar-container").evaluate((element) => getComputedStyle(element).transitionDuration)).not.toBe(motion.panelDuration);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => page.locator(".sidebar-container").evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(motion.panelDuration);
  });
}

test("appearance opening keeps a short opacity acknowledgment without sliding", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSessions(page, 1440, "trae");
  await page.evaluate(() => {
    document.addEventListener("animationstart", (event) => {
      if (!(event instanceof AnimationEvent) || !event.animationName.includes("appearance-in") || !(event.target instanceof HTMLElement)) return;
      const animation = event.target.getAnimations().find((item) => item instanceof CSSAnimation && item.animationName === event.animationName);
      const effect = animation?.effect as KeyframeEffect | null;
      document.documentElement.dataset.openingMotion = JSON.stringify(effect?.getKeyframes() ?? []);
    });
  });
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Appearance" })).toBeVisible();
  await expect.poll(() => page.locator("html").getAttribute("data-opening-motion")).toBeTruthy();
  const frames = JSON.parse((await page.locator("html").getAttribute("data-opening-motion"))!) as { opacity?: string; transform?: string }[];
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.some((frame) => Number(frame.opacity) < 1)).toBe(true);
  expect(frames.every((frame) => !frame.transform || frame.transform === "none")).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Appearance" })).toHaveCount(0);
});

test("welcome text stops typing and blinking when the preference changes", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSessions(page, 1440, "trae");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const welcome = page.getByTestId("welcome-typewriter");
  await expect(welcome).toHaveText("ready when you are.");
  await expect(welcome.locator('[aria-hidden="true"]')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(welcome.locator('[aria-hidden="true"]')).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(welcome).toHaveText("ready when you are.");
  await expect(welcome.locator('[aria-hidden="true"]')).toHaveCount(0);
});
