import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeFilePathForApi } from "../lib/file-paths";
import { isFixtureReadReceipt } from "./read-receipt-fixture";

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=", "base64");
const BINARY = Buffer.from([0x50, 0x69, 0x00, 0x57, 0x65, 0x62]);

function wavFixture() {
  const sampleRate = 8_000;
  const samples = sampleRate; // One second of silent, mono, 16-bit PCM.
  const dataBytes = samples * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}

function pdfFixture() {
  const stream = "BT /F1 12 Tf 18 60 Td (Local media fixture) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 180 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let document = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document);
}

async function settleFileLayout(panel: Locator) {
  await expect.poll(() => panel.evaluate(element => [element, ...element.parentElement!.children]
    .flatMap(node => node.getAnimations()).some(animation => animation instanceof CSSTransition && animation.playState === "running")),
  { message: "File panel and sidebar width transitions must settle before the next navigation" }).toBe(false);
}

async function openExplorerFile(page: Page, directory: string | null, filename: string) {
  const panel = page.locator(".right-panel-container");
  if (await panel.getAttribute("class").then(value => value?.includes("right-panel-open"))) {
    await panel.getByRole("button", { name: /^(Hide file panel|Back to chat)$/ }).click();
    await expect(panel).toHaveClass(/right-panel-closed/);
  }
  await settleFileLayout(panel);
  const explorer = page.locator('.sidebar-container.sidebar-open[data-panel-view="files"]');
  if (await explorer.count() === 0) {
    await page.getByRole("button", { name: /^(Explorer|Files)$/ }).first().click();
  }
  await expect(explorer).toBeVisible();
  await settleFileLayout(panel);
  const tree = explorer.getByRole("tree", { name: "Explorer", exact: true });
  if (directory) {
    const folder = tree.getByRole("treeitem", { name: directory, exact: true });
    await expect(folder).toBeVisible();
    if (await folder.getAttribute("aria-expanded") !== "true") await folder.click();
  }
  await tree.getByRole("treeitem", { name: filename, exact: true }).click();
  await expect(panel).toHaveClass(/right-panel-open/);
  // AppShell collapses Explorer asynchronously to make room for the file pane.
  // Its class must commit before checking transitions or reopening Explorer.
  if ((page.viewportSize()?.width ?? Infinity) < 1600) {
    await expect(page.locator(".sidebar-container")).toHaveClass(/sidebar-closed/);
  }
  await settleFileLayout(panel);
  return panel;
}

async function withinPane(element: Locator, pane: Locator) {
  await expect(element).toBeVisible();
  await expect.poll(async () => {
    const box = await element.boundingBox();
    const bounds = await pane.boundingBox();
    return !!box && !!bounds && box.width > 0 && box.height > 0
      && box.x >= bounds.x - 1 && box.y >= bounds.y - 1
      && box.x + box.width <= bounds.x + bounds.width + 1
      && box.y + box.height <= bounds.y + bounds.height + 1;
  }, { message: "Media controls must remain inside their file pane" }).toBe(true);
}

async function toolbarGeometry(page: Page, panel: Locator, toolbar: Locator, filePath: string, projectRoot: string, touch: boolean) {
  await withinPane(toolbar, panel);
  const identity = toolbar.getByTitle(filePath, { exact: true });
  await expect(identity).toBeVisible();
  await expect(identity).toHaveText(path.relative(projectRoot, filePath));
  await expect.poll(() => toolbar.evaluate(element => {
    const box = element.getBoundingClientRect();
    const inside = (candidate: DOMRect) => candidate.left >= box.left - 1 && candidate.right <= box.right + 1
      && candidate.top >= box.top - 1 && candidate.bottom <= box.bottom + 1;
    return box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1
      && element.scrollWidth <= element.clientWidth + 1
      && [...element.children].every(child => inside(child.getBoundingClientRect()));
  }), { message: "Toolbar identity, metadata and controls must fit without horizontal overflow" }).toBe(true);
  for (const control of await toolbar.locator("button, a").all()) {
    await withinPane(control, toolbar);
    if (touch) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function downloadBytes(page: Page, toolbar: Locator, filePath: string, expected: Buffer) {
  const link = toolbar.getByRole("link", { name: "Download file", exact: true });
  await expect(link).toBeVisible();
  const href = `/api/files/${encodeFilePathForApi(filePath)}?type=download`;
  await expect(link).toHaveAttribute("href", href);
  await expect(link).toHaveAttribute("download");
  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toContain("attachment;");
  expect(await response.body()).toEqual(expected);
}

for (const style of ["original", "trae"] as const) {
  test(`${style}: rendered media toolbars preserve identity and controls at phone and desktop widths`, async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const configuredProject = process.env.E2E_PROJECT_CWD;
    if (!configuredProject || !baseURL) throw new Error("Media geometry checks require the isolated E2E project and server");
    const projectRoot = path.resolve(configuredProject);
    const directory = await mkdtemp(path.join(projectRoot, "media-toolbar-"));
    const folder = path.basename(directory);
    const imagePath = path.join(directory, "tiny-preview.png");
    const audioPath = path.join(directory, "silent-preview.wav");
    const pdfPath = path.join(directory, "local-preview.pdf");
    const binaryPath = path.join(projectRoot, "sample.bin");
    const pdf = pdfFixture();
    const forbidden: string[] = [];
    const external: string[] = [];
    const origin = new URL(baseURL).origin;
    try {
      await Promise.all([writeFile(imagePath, PNG), writeFile(audioPath, wavFixture()), writeFile(pdfPath, pdf)]);
      await page.addInitScript(style => {
        if (window !== window.top) return;
        localStorage.setItem("pi-ui-style", style);
        localStorage.setItem("pi-locale", "en");
        localStorage.setItem("pi-right-width", "320");
        localStorage.setItem("pi-composer-hints", "off");
      }, style);
      await page.route(url => ["http:", "https:"].includes(url.protocol) && url.origin !== origin, route => {
        external.push(route.request().url());
        return route.abort("blockedbyclient");
      });
      await page.route(url => url.origin === origin && url.pathname.startsWith("/api/"), async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (["GET", "HEAD"].includes(request.method())) return route.continue();
        let body: Record<string, unknown> | undefined;
        try { body = request.postDataJSON(); } catch { /* Deny other mutations. */ }
        if (request.method() === "POST" && pathname === "/api/worktrees" && body
          && Object.keys(body).length === 1 && Array.isArray(body.cwds)
          && body.cwds.length <= 128 && body.cwds.every(cwd => typeof cwd === "string" && cwd.length > 0)) return route.continue();
        if (request.method() === "POST" && /^\/api\/agent\/[^/]+$/.test(pathname) && body?.type === "get_tools") {
          return route.fulfill({ json: { success: true, data: [] } });
        }
        if (isFixtureReadReceipt(request)) return route.continue();
        forbidden.push(`${request.method()} ${pathname}`);
        return route.fulfill({ status: 403, json: { error: "Media layout checks forbid model calls and mutations" } });
      });

      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/?session=${SESSION}`);
        await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
        await expect(page.getByTestId("composer-shell").locator("textarea")).toBeAttached();

        const imagePanel = await openExplorerFile(page, folder, path.basename(imagePath));
        const imageToolbar = imagePanel.locator('[class*="ImageViewer_toolbar"]');
        const image = imagePanel.getByAltText(imagePath, { exact: true });
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth === 1 && element.naturalHeight === 1)).toBe(true);
        await toolbarGeometry(page, imagePanel, imageToolbar, imagePath, projectRoot, width <= 700);
        await imageToolbar.getByRole("button", { name: "Zoom in", exact: true }).click();
        const reset = imageToolbar.getByRole("button", { name: "Reset zoom", exact: true });
        await expect(reset).toContainText("125%");
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.style.transform)).toContain("scale(1.25)");
        await toolbarGeometry(page, imagePanel, imageToolbar, imagePath, projectRoot, width <= 700);
        await reset.click();
        await expect(reset).toContainText("100%");
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.style.transform)).toBe("translate(0px, 0px) scale(1)");
        await expect(imageToolbar.getByRole("button", { name: "Zoom out", exact: true })).toBeDisabled();

        const audioPanel = await openExplorerFile(page, folder, path.basename(audioPath));
        const audioToolbar = audioPanel.locator('[class*="MediaViewer_toolbar"]');
        const audio = audioPanel.locator("audio");
        await expect(audio).toHaveAttribute("controls", "");
        await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState >= 1 && element.duration === 1)).toBe(true);
        await expect(audioToolbar.getByText("0:01", { exact: true })).toBeVisible();
        await withinPane(audio, audioPanel);
        await toolbarGeometry(page, audioPanel, audioToolbar, audioPath, projectRoot, width <= 700);

        const documentPanel = await openExplorerFile(page, folder, path.basename(pdfPath));
        const documentToolbar = documentPanel.locator('[class*="DocumentViewer_toolbar"]');
        const frame = documentPanel.getByTitle(`Preview ${path.basename(pdfPath)}`, { exact: true });
        await withinPane(frame, documentPanel);
        const previewUrl = `/api/files/${encodeFilePathForApi(pdfPath)}?type=read`;
        await expect(frame).toHaveAttribute("src", previewUrl);
        const previewResponse = await page.request.get(previewUrl);
        expect(previewResponse.status()).toBe(200);
        expect(previewResponse.headers()["content-type"]).toContain("application/pdf");
        expect(await previewResponse.body()).toEqual(pdf);
        await toolbarGeometry(page, documentPanel, documentToolbar, pdfPath, projectRoot, width <= 700);
        await downloadBytes(page, documentToolbar, pdfPath, pdf);

        const binaryPanel = await openExplorerFile(page, null, "sample.bin");
        const binaryToolbar = binaryPanel.locator('[class*="BinaryViewer_toolbar"]');
        await expect(binaryPanel.getByText(/00000000\s+50 69 00 57 65 62/)).toBeVisible();
        await toolbarGeometry(page, binaryPanel, binaryToolbar, binaryPath, projectRoot, width <= 700);
        await downloadBytes(page, binaryToolbar, binaryPath, BINARY);
      }
      expect(forbidden, "Media browsing must not invoke a model or mutate the fixture project/session").toEqual([]);
      expect(external, "Offline media previews must not load external resources").toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
