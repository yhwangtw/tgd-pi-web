import { expect, test, type Page } from "@playwright/test";

const session = "aaaa1111-2222-3333-4444-555566667777";

async function installCapture(page: Page, support = true) {
  await page.addInitScript(supported => {
    const probe = { calls: 0, streams: [] as MediaStream[], options: null as unknown };
    Object.assign(window, { screenshotProbe: probe });
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: supported ? async (options: unknown) => {
        probe.calls++; probe.options = options;
        const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#19472b"; context.fillRect(0, 0, 1280, 720);
        context.fillStyle = "#ffffff"; context.font = "32px sans-serif";
        context.fillText("Screenshot fixture", 50, 80);
        const stream = canvas.captureStream(10); probe.streams.push(stream);
        const paint = () => {
          if (stream.getVideoTracks()[0].readyState === "ended") return;
          context.fillRect(10, 10, 4, 4); requestAnimationFrame(paint);
        };
        requestAnimationFrame(paint);
        return stream;
      } : undefined,
    });
  }, support);
}
const stopped = (page: Page) => page.evaluate(() => {
  const probe = (window as unknown as { screenshotProbe: { streams: MediaStream[] } }).screenshotProbe;
  return probe.streams.length > 0 && probe.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended"));
});

for (const style of ["original", "trae"]) for (const width of [390, 1440]) {
  test(`${style} ${width}: captures a real video frame, stops sharing and confirms an attachment`, async ({ page }, info) => {
    await page.addInitScript(style => { localStorage.setItem("pi-ui-style", style); localStorage.setItem("pi-locale", "en"); }, style);
    await page.setViewportSize({ width, height: 900 });
    await installCapture(page);
    await page.goto(`/?session=${session}`);
    const composer = page.getByTestId("composer-shell");
    await composer.locator("textarea").fill("inspect this screenshot");
    const capture = page.getByRole("button", { name: "Take screenshot", exact: true });
    await expect(capture).toBeVisible(); await capture.click();
    const dialog = page.getByTestId("screenshot-dialog");
    await expect(dialog.getByRole("img", { name: "Screenshot preview" })).toBeVisible();
    await expect(dialog).toContainText("1280 × 720");
    await expect.poll(() => stopped(page)).toBe(true);
    expect(await dialog.getByRole("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1280);
    await expect(page.getByRole("button", { name: "Remove image", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`screenshot-${style}-${width}.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "Retake", exact: true }).click();
    await expect(dialog.getByRole("img")).toBeVisible();
    await dialog.getByRole("button", { name: "Attach screenshot", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove image", exact: true })).toBeVisible();
    await expect(composer.locator("textarea")).toHaveValue("inspect this screenshot");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect.poll(() => stopped(page)).toBe(true);
    await page.getByRole("button", { name: "Remove image", exact: true }).click();
    await capture.click(); await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove image", exact: true })).toHaveCount(0);
  });
}

test("unsupported capture offers system screenshots and the existing file picker on a narrow screen", async ({ page }) => {
  await installCapture(page, false);
  await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`/?session=${session}`);
  await page.getByRole("button", { name: "Take screenshot", exact: true }).click();
  const dialog = page.getByTestId("screenshot-dialog");
  await expect(dialog).toContainText("Win + Shift + S");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const file = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose an image", exact: true }).click();
  await (await file).setFiles({ name: "system-screenshot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64") });
  await expect(page.getByRole("button", { name: "Remove image", exact: true })).toBeVisible();
});
