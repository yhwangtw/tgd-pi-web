import { test, expect } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

for (const style of ["original", "trae"]) for (const width of [390, 1440]) {
  test(`${style} ${width}: settings remain scrollable while the composer stays usable`, async ({ page }, info) => {
    await page.addInitScript(style => {
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-locale", "en");
    }, style);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(MAIN);
    const composer = page.getByTestId("composer-shell").locator("textarea");
    await expect(composer).toBeVisible();
    if (width < 700) await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    const panel = page.getByTestId("skills-config-dialog");
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveAttribute("aria-modal", "true");
    expect(await composer.evaluate(element => element.closest("[inert]"))).toBeNull();
    await composer.fill("Typing while the panel is expanded");
    await expect(composer).toBeFocused();
    const box = (await panel.boundingBox())!;
    expect(box.height).toBeLessThan(900 * (width < 700 ? 0.56 : 0.81));
    expect(await panel.locator("header p").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const nav = page.getByTestId("skills-config-nav");
    await nav.getByRole("button", { name: /e2e-reading/ }).click();
    const detail = page.getByTestId("skills-config-detail");
    await expect(detail).toBeVisible();
    // Each layout may place scrolling on the detail itself or its inner copy.
    const scrolled = await detail.evaluate(element => {
      const candidates = [element, ...element.querySelectorAll<HTMLElement>("*")];
      const target = candidates.find(node => node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(node).overflowY));
      if (!target) return false;
      target.scrollTop = 160; return target.scrollTop > 0;
    });
    expect(scrolled).toBe(true);
    await panel.getByRole("button", { name: "Minimize panel" }).click();
    await expect(detail).toBeHidden();
    await composer.fill(`Draft remains usable in ${style} ${width}`);
    await expect(composer).toBeFocused();
    await panel.getByRole("button", { name: "Expand panel" }).click();
    await expect(detail).toBeVisible();
    await expect(composer).toHaveValue(`Draft remains usable in ${style} ${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("nonblocking-skills.png") });
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(composer).toHaveValue(`Draft remains usable in ${style} ${width}`);
  });
}

test("large text loads further chunks through the real API and retains download access", async ({ page }, info) => {
  await page.goto(MAIN);
  await expect(page.getByTestId("composer-shell")).toBeVisible();
  await page.getByRole("button", { name: /^(Explorer|Files)$/ }).first().click();
  await page.getByRole("treeitem", { name: "large-preview.txt" }).click();
  const panel = page.locator(".right-panel-container");
  await expect(panel.getByText(/Loaded 256/)).toBeVisible();
  const response = page.waitForResponse(response => response.url().includes("large-preview.txt") && response.url().includes("previewBytes=524288"));
  await panel.getByRole("button", { name: "Load more", exact: true }).click();
  const body = await (await response).json();
  expect(Buffer.byteLength(body.content)).toBeGreaterThan(500_000);
  expect(body.content).not.toContain("\uFFFD");
  expect(body.version).toBeUndefined();
  await expect(panel.getByText(/Loaded 512/)).toBeVisible();
  await expect(panel.getByRole("link", { name: "Open full file" })).toHaveAttribute("href", /type=raw$/);
  const download = panel.getByRole("link", { name: "Download the full file" });
  await expect(download).toHaveAttribute("href", /type=download$/);
  const file = await page.request.get((await download.getAttribute("href"))!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-disposition"]).toContain("attachment");
  expect((await file.body()).length).toBeGreaterThan(524288);
  await page.screenshot({ path: info.outputPath("incremental-preview.png") });
});

test("draft and reading position survive navigation and reload", async ({ page }) => {
  await page.goto(MAIN);
  const composer = page.getByTestId("composer-shell").locator("textarea");
  await expect(composer).toBeVisible();
  const transcript = page.locator("[data-transcript-scroll]");
  await transcript.evaluate(element => { element.scrollTop = 220; element.dispatchEvent(new Event("scroll")); });
  // Visiting skipped history materializes content-visibility placeholders.
  // Chromium preserves its reading anchor by adjusting scrollTop (e.g. 220
  // becomes 179). Record the settled position, not the requested offset.
  const readingPosition = await transcript.evaluate(async element => {
    await document.fonts.ready;
    let previous = -1;
    let stableFrames = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(requestAnimationFrame);
      const current = element.scrollTop;
      stableFrames = current === previous ? stableFrames + 1 : 0;
      if (stableFrames >= 6) return current;
      previous = current;
    }
    throw new Error("Transcript reading position did not settle");
  });
  expect(readingPosition).toBeGreaterThan(100);
  await expect.poll(() => page.evaluate(() => {
    const positions = new Map<string, number>(JSON.parse(sessionStorage.getItem("pi-transcript-positions") ?? "[]"));
    return positions.get("aaaa1111-2222-3333-4444-555566667777");
  })).toBe(readingPosition);
  await composer.fill("Unsaved first conversation");
  // Other integration tests create conversations; an older fixture can be
  // outside the virtualized sidebar. Find it through the actual search UI.
  const search = page.getByRole("textbox", { name: "Search conversations", exact: true });
  await search.fill("結構化輸出設計");
  await page.getByRole("listbox", { name: "Sessions", exact: true }).getByRole("option", { name: /^結構化輸出設計/ }).click();
  await expect(composer).toHaveValue("");
  await composer.fill("Unsaved second conversation");
  await search.fill("專案架構分析");
  await page.getByRole("listbox", { name: "Sessions", exact: true }).getByRole("option", { name: /^專案架構分析/ }).click();
  await expect(composer).toHaveValue("Unsaved first conversation");
  await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeCloseTo(readingPosition, 0);
  await page.reload();
  await expect(composer).toHaveValue("Unsaved first conversation");
  await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeCloseTo(readingPosition, 0);
});

test("subagent budgets are editable and persist without starting any run", async ({ page }) => {
  await page.goto(MAIN);
  await expect(page.getByTestId("composer-shell")).toBeVisible();
  const before = await (await page.request.get("/api/agent-runs")).json();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const dashboard = page.getByTestId("agent-dashboard");
  await dashboard.getByText("Subagent budgets", { exact: true }).click();
  await dashboard.getByRole("spinbutton", { name: "Turns", exact: true }).fill("0");
  await dashboard.getByRole("spinbutton", { name: "Reported cost (US$)", exact: true }).fill("3.50");
  await dashboard.getByRole("spinbutton", { name: "Minutes", exact: true }).fill("45");
  await dashboard.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dashboard.getByRole("status")).toContainText("Saved");
  const after = await (await page.request.get("/api/agent-runs")).json();
  expect(after.subagentLimits).toEqual({ maxTurns: 0, maxCostUsd: 3.5, timeoutMs: 2_700_000 });
  expect(after.runs.map((run: { id: string }) => run.id)).toEqual(before.runs.map((run: { id: string }) => run.id));
  await page.reload();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await dashboard.getByText("Subagent budgets", { exact: true }).click();
  await expect(dashboard.getByRole("spinbutton", { name: "Turns", exact: true })).toHaveValue("0");
  await expect(dashboard.getByRole("spinbutton", { name: "Minutes", exact: true })).toHaveValue("45");
});
