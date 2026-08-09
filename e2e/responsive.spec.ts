import { expect, test, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
const MAIN_ID = "aaaa1111-2222-3333-4444-555566667777";
// This fixture is never activated through the agent API, so the System action
// must remain unavailable even when another spec has started MAIN's wrapper.
const INACTIVE = "/?session=dddd1111-2222-3333-4444-555566667777";

async function openSession(page: Page, url = MAIN) {
  await page.goto(url);
  await expect(page.getByRole("textbox", { name: "Message…" })).toBeVisible({
    timeout: 20_000,
  });
}

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
}

test.describe("responsive shell", () => {
  for (const viewport of [
    { width: 320, height: 800 },
    { width: 768, height: 900 },
    { width: 1024, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    test(`AC-RWD-1: ${viewport.width}px keeps the chat usable without page overflow`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openSession(page);

      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Message…" })).toBeVisible();
      await expectNoPageOverflow(page);
    });
  }

  test("AC-RWD-1b: tablet sidebar is an opaque modal layer over the transcript", async ({ page }) => {
    await page.setViewportSize({ width: 840, height: 889 });
    await openSession(page);

    const sidebar = page.locator(".sidebar-container");
    const backdrop = page.locator(".sidebar-overlay-backdrop");
    await expect(sidebar).toHaveClass(/sidebar-closed/);

    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await expect(sidebar).toHaveClass(/sidebar-open/);
    await expect(backdrop).toBeVisible();

    const overlayStyles = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".sidebar-container")!;
      const shade = document.querySelector<HTMLElement>(".sidebar-overlay-backdrop")!;
      return {
        panelBackground: getComputedStyle(panel).backgroundColor,
        panelOverflow: getComputedStyle(panel).overflow,
        shadeBackground: getComputedStyle(shade).backgroundColor,
        shadePosition: getComputedStyle(shade).position,
        shadePointerEvents: getComputedStyle(shade).pointerEvents,
      };
    });

    expect(overlayStyles.panelBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(overlayStyles.panelBackground).not.toBe("transparent");
    expect(overlayStyles.panelOverflow).toBe("hidden");
    expect(overlayStyles.shadeBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(overlayStyles.shadePosition).toBe("fixed");
    expect(overlayStyles.shadePointerEvents).toBe("auto");

    const [railBox, backdropBox] = await Promise.all([
      page.getByRole("navigation", { name: "Primary" }).boundingBox(),
      backdrop.boundingBox(),
    ]);
    expect(railBox).not.toBeNull();
    expect(backdropBox).not.toBeNull();
    expect(backdropBox!.x).toBeCloseTo(railBox!.x + railBox!.width, 0);
    await expectNoPageOverflow(page);
  });

  for (const modal of [
    {
      button: "Models",
      name: "Models",
      dialog: "models-config-dialog",
      nav: "models-config-nav",
      detail: "models-config-detail",
    },
    {
      button: "Skills",
      name: "Skills",
      dialog: "skills-config-dialog",
      nav: "skills-config-nav",
      detail: "skills-config-detail",
    },
  ]) {
    test(`AC-RWD-2: ${modal.name} becomes a full-width single-column dialog at 320px`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await openSession(page);
      await page.evaluate(() => localStorage.setItem("pi-font-size", "xlarge"));
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Message…" })).toBeVisible();

      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("button", { name: modal.button, exact: true }).click();
      const dialog = page.getByTestId(modal.dialog);
      const nav = page.getByTestId(modal.nav);
      const detail = page.getByTestId(modal.detail);
      await expect(dialog).toHaveAttribute("role", "dialog");
      await expect(dialog).toHaveAttribute("aria-modal", "true");

      const [dialogBox, navBox, detailBox] = await Promise.all([
        dialog.boundingBox(),
        nav.boundingBox(),
        detail.boundingBox(),
      ]);
      expect(dialogBox).not.toBeNull();
      expect(navBox).not.toBeNull();
      expect(detailBox).not.toBeNull();
      expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(320);
      expect(navBox!.width).toBeGreaterThanOrEqual(300);
      expect(detailBox!.width).toBeGreaterThanOrEqual(300);
      expect(detailBox!.y).toBeGreaterThanOrEqual(navBox!.y + navBox!.height - 1);
      await expectNoPageOverflow(page);
    });
  }

  test("AC-RWD-3: coarse-pointer controls provide 44px touch targets", async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 320, height: 800 },
    });
    const page = await context.newPage();
    await openSession(page);

    for (const control of [
      page.getByRole("button", { name: "Sessions", exact: true }),
      page.getByRole("button", { name: "Attach image", exact: true }),
      page.getByRole("button", { name: "Files", exact: true }),
    ]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    await context.close();
  });

  test("AC-RWD-4: AppShell consumes safe-area inset variables", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openSession(page);
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--safe-area-top", "11px");
      document.documentElement.style.setProperty("--safe-area-right", "12px");
      document.documentElement.style.setProperty("--safe-area-bottom", "13px");
      document.documentElement.style.setProperty("--safe-area-left", "14px");
    });

    await expect(page.getByTestId("app-shell")).toHaveCSS("padding", "11px 12px 67px 14px");
    await expectNoPageOverflow(page);
  });

  test("AC-RWD-5: opening a file on mobile dismisses Explorer and keeps the viewer in the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openSession(page);

    await page.getByRole("button", { name: "Files", exact: true }).click();
    const sidebar = page.locator(".sidebar-container");
    await expect(sidebar).toHaveClass(/sidebar-open/);
    await expect(page.getByText("README.md", { exact: true })).toBeVisible();

    await page.getByText("README.md", { exact: true }).click();

    const viewer = page.locator(".right-panel-container");
    await expect(sidebar).toHaveClass(/sidebar-closed/);
    await expect(viewer).toHaveClass(/right-panel-open/);
    await expect(page.getByText("E2E fixture.", { exact: true })).toBeVisible();

    const viewerBox = await viewer.boundingBox();
    expect(viewerBox).not.toBeNull();
    expect(viewerBox!.x).toBeGreaterThanOrEqual(0);
    expect(viewerBox!.x + viewerBox!.width).toBeLessThanOrEqual(320);
    const touchControls = viewer.locator("[data-testid='right-panel-tab-bar'] button, [data-testid='file-viewer-toolbar'] button");
    const touchControlHeights = await touchControls.evaluateAll((buttons) =>
      buttons
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((button) => button.getBoundingClientRect().height),
    );
    expect(touchControlHeights.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...touchControlHeights)).toBeGreaterThanOrEqual(44);
    await expectNoPageOverflow(page);

    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(sidebar).toHaveClass(/sidebar-open/);
    await expect(sidebar.getByText("README.md", { exact: true })).toBeVisible();
  });

  test("AC-RWD-6: mobile composer preserves typing space and keeps Send visible", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openSession(page);

    const shell = page.getByTestId("composer-shell");
    const inputRow = page.getByTestId("composer-input-row");
    const toolbar = page.getByTestId("composer-toolbar");
    const textarea = page.getByRole("textbox", { name: "Message…" });
    const send = page.getByRole("button", { name: "Send", exact: true });

    await expect(shell).toBeVisible();
    await expect(send).toBeVisible();
    await expect(inputRow.getByRole("textbox", { name: "Message…" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Send", exact: true })).toBeVisible();

    const [shellBox, textareaBox, sendBox] = await Promise.all([
      shell.boundingBox(),
      textarea.boundingBox(),
      send.boundingBox(),
    ]);
    expect(shellBox).not.toBeNull();
    expect(textareaBox).not.toBeNull();
    expect(sendBox).not.toBeNull();
    expect(textareaBox!.width).toBeGreaterThanOrEqual(200);
    expect(textareaBox!.width).toBeGreaterThanOrEqual(shellBox!.width * 0.75);
    expect(Math.abs(textareaBox!.y - sendBox!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(textareaBox!.height - sendBox!.height)).toBeLessThanOrEqual(1);
    expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(320);

    const controlsTrigger = page.getByRole("button", { name: "More composer controls" });
    await controlsTrigger.click();
    const controls = page.locator("#composer-secondary-tools");
    await expect(controls).toBeVisible();
    await expect(controls.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    const [controlsBox, openTextareaBox] = await Promise.all([
      controls.boundingBox(),
      textarea.boundingBox(),
    ]);
    expect(controlsBox).not.toBeNull();
    expect(openTextareaBox).not.toBeNull();
    expect(controlsBox!.x).toBeGreaterThanOrEqual(0);
    expect(controlsBox!.x + controlsBox!.width).toBeLessThanOrEqual(320);
    expect(controlsBox!.y).toBeGreaterThanOrEqual(openTextareaBox!.y + openTextareaBox!.height - 1);
    await expectNoPageOverflow(page);

    await controls.getByRole("button", { name: "Done", exact: true }).click();
    await expect(controls).toBeHidden();
  });

  test("AC-RWD-7: reasoning controls use Traditional Chinese without simplified Chinese", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh"));
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(MAIN);
    await expect(page.getByRole("textbox", { name: "輸入訊息…" })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("button", { name: "更多輸入框設定" }).click();
    await page.getByRole("button", { name: "切換推理層級" }).click();
    await expect(page.getByText("沿用 Pi 預設值", { exact: true })).toBeVisible();
    await expect(page.getByText("低強度推理", { exact: true })).toBeVisible();
    await expect(page.getByText("最高強度推理", { exact: true })).toBeVisible();
    await expect(page.getByText(/切换|默认|关闭|强度|设置/)).toHaveCount(0);
  });

  test("AC-RWD-8: mobile file-panel controls stay inside their own toolbars", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openSession(page);

    const topBar = page.getByTestId("top-bar");
    const showPanel = topBar.getByRole("button", { name: "Show file panel", exact: true });
    await expect(showPanel).toBeVisible();

    const [topBarBox, showBox] = await Promise.all([
      topBar.boundingBox(),
      showPanel.boundingBox(),
    ]);
    expect(topBarBox).not.toBeNull();
    expect(showBox).not.toBeNull();
    expect(showBox!.x).toBeGreaterThanOrEqual(topBarBox!.x);
    expect(showBox!.x + showBox!.width).toBeLessThanOrEqual(topBarBox!.x + topBarBox!.width);

    await showPanel.click();
    const viewer = page.locator(".right-panel-container.right-panel-open");
    const panelBar = page.getByTestId("right-panel-tab-bar");
    const hidePanel = panelBar.getByRole("button", { name: "Hide file panel", exact: true });
    await expect(viewer).toBeVisible();
    await expect(hidePanel).toBeVisible();

    const [panelBarBox, hideBox] = await Promise.all([
      panelBar.boundingBox(),
      hidePanel.boundingBox(),
    ]);
    expect(panelBarBox).not.toBeNull();
    expect(hideBox).not.toBeNull();
    expect(hideBox!.x).toBeGreaterThanOrEqual(panelBarBox!.x);
    expect(hideBox!.x + hideBox!.width).toBeLessThanOrEqual(panelBarBox!.x + panelBarBox!.width);
    await expectNoPageOverflow(page);
  });

  test("AC-RWD-9: desktop session header keeps usage compact and actionable", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSession(page);

    const topBar = page.getByTestId("top-bar");
    const identity = page.getByTestId("session-identity");
    const workspace = identity.getByRole("button", { name: /Select project/ });
    const repository = identity.getByTestId("workspace-repository");
    const branch = identity.getByTestId("workspace-branch");
    const title = topBar.locator("[class*='chatTitle']");
    const sessionMenu = topBar.getByRole("button", { name: "Session actions" });
    const usage = page.getByTestId("session-usage-summary");
    const filePanel = topBar.getByRole("button", { name: "Show file panel" });

    await expect(usage).toBeVisible();
    await expect(topBar.getByText("IN", { exact: true })).toHaveCount(0);
    await expect(topBar.getByText("OUT", { exact: true })).toHaveCount(0);
    await expect(topBar.getByText("CACHE", { exact: true })).toHaveCount(0);

    const [topBarBox, identityBox, workspaceBox, titleBox, menuBox, usageBox, filePanelBox] = await Promise.all([
      topBar.boundingBox(),
      identity.boundingBox(),
      workspace.boundingBox(),
      title.boundingBox(),
      sessionMenu.boundingBox(),
      usage.boundingBox(),
      filePanel.boundingBox(),
    ]);
    expect(topBarBox).not.toBeNull();
    expect(identityBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    expect(usageBox).not.toBeNull();
    expect(filePanelBox).not.toBeNull();
    expect(identityBox!.y).toBeGreaterThan(topBarBox!.y);
    expect(identityBox!.y + identityBox!.height).toBeLessThan(topBarBox!.y + topBarBox!.height);
    expect(Math.abs(
      workspaceBox!.y + workspaceBox!.height / 2
      - (titleBox!.y + titleBox!.height / 2),
    )).toBeLessThanOrEqual(1);
    expect(menuBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width);
    expect(usageBox!.x - (menuBox!.x + menuBox!.width)).toBeGreaterThanOrEqual(6);
    expect(filePanelBox!.x - (usageBox!.x + usageBox!.width)).toBeGreaterThanOrEqual(6);
    expect(usageBox!.width).toBeLessThanOrEqual(160);
    await expect(title).toHaveCSS("font-size", "14px");
    await expect(repository).toHaveCSS("font-size", "12px");
    await expect(branch).toHaveCSS("font-size", "12px");
    await expect(sessionMenu).toHaveCSS("font-size", "13px");
    expect(await branch.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await usage.click();
    await expect(page.getByRole("heading", { name: "Session Analytics" })).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test("AC-RWD-9a: mobile TRAE analytics tables remain horizontally scrollable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem("pi-ui-style", "trae");
      localStorage.setItem("pi-skin", "trae");
    });
    await openSession(page);

    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Analytics", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Session Analytics" });
    await expect(dialog).toBeVisible();

    const table = dialog.locator("[class*='table']").first();
    await expect(table).toBeVisible();
    await expect.poll(() => table.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
    await expect.poll(() => table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await expectNoPageOverflow(page);
  });

  test("AC-RWD-9b: session overlays stay above the transcript and hide dead branch actions", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSession(page, INACTIVE);

    await page.getByRole("button", { name: "Session actions" }).click();
    const branches = page.getByRole("menuitem", { name: /Branches/ });
    await expect(branches).toBeDisabled();
    await expect(branches).toContainText("No alternate turns");
    await expect(page.getByRole("menuitem", { name: /HTML/ })).toContainText("Downloads .html · keeps the full layout");
    await expect(page.getByRole("menuitem", { name: /Markdown/ })).toContainText("Downloads .md · easy to edit or paste");

    const system = page.getByRole("menuitem", { name: /System/ });
    await expect(system).toBeDisabled();
    await expect(system).toContainText("Unavailable until this session is active");
    await expect(page.getByTestId("system-prompt-panel")).toHaveCount(0);
    await expectNoPageOverflow(page);
  });

  test("AC-RWD-10: mobile header shows repository and branch at first glance", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openSession(page);

    const identity = page.getByTestId("session-identity");
    await expect(identity.getByTestId("workspace-repository")).toHaveText("demo-project");
    await expect(identity.getByTestId("workspace-branch")).not.toHaveText("");
    await expect(identity.getByTestId("workspace-repository")).toBeVisible();
    await expect(identity.getByTestId("workspace-branch")).toBeVisible();
    await expect(identity.locator("[class*='chatTitle']")).toBeHidden();

    const [topBarBox, workspaceBox] = await Promise.all([
      page.getByTestId("top-bar").boundingBox(),
      identity.getByRole("button", { name: /Select project/ }).boundingBox(),
    ]);
    expect(topBarBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect(workspaceBox!.y).toBeGreaterThan(topBarBox!.y);
    expect(workspaceBox!.y + workspaceBox!.height).toBeLessThan(topBarBox!.y + topBarBox!.height);

    const workspaceButton = identity.getByRole("button", { name: /Select project/ });
    await expect(workspaceButton).toBeVisible();
    await workspaceButton.click();
    await expect(page.getByTestId("project-switcher")).toBeVisible();
    await page.keyboard.press("Escape");
    await expectNoPageOverflow(page);
  });

  test("AC-RWD-11: mobile session actions stay in one compact row", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openSession(page);
    const activation = await page.request.post(`/api/agent/${MAIN_ID}`, {
      data: { type: "get_state" },
    });
    expect(activation.ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message…" })).toBeVisible();

    await page.getByRole("button", { name: "Session actions", exact: true }).click();
    const panel = page.locator("[class*='chatActionsMobileOpen']");
    const exportAction = panel.getByRole("button", { name: "Choose export format" });
    const analyticsAction = panel.getByRole("button", { name: "Token usage and cost report" });
    const systemAction = panel.getByRole("button", { name: "System", exact: true });
    await expect(panel).toBeVisible();

    const [panelBox, exportBox, analyticsBox, systemBox] = await Promise.all([
      panel.boundingBox(),
      exportAction.boundingBox(),
      analyticsAction.boundingBox(),
      systemAction.boundingBox(),
    ]);
    expect(panelBox).not.toBeNull();
    expect(exportBox).not.toBeNull();
    expect(analyticsBox).not.toBeNull();
    expect(systemBox).not.toBeNull();
    expect(panelBox!.width).toBeLessThanOrEqual(320);
    expect(panelBox!.height).toBeLessThanOrEqual(64);
    expect(Math.abs(exportBox!.y - analyticsBox!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(analyticsBox!.y - systemBox!.y)).toBeLessThanOrEqual(1);

    await exportAction.click();
    const exportMenu = page.getByRole("menu");
    await expect(exportMenu).toBeVisible();
    const exportMenuBox = await exportMenu.boundingBox();
    expect(exportMenuBox).not.toBeNull();
    expect(exportMenuBox!.x).toBeGreaterThanOrEqual(8);
    expect(exportMenuBox!.x + exportMenuBox!.width).toBeLessThanOrEqual(312);

    await exportAction.click();
    await expect(systemAction).toBeEnabled();
    await systemAction.click();
    const systemPanel = page.getByTestId("system-prompt-panel");
    await expect(systemPanel).toBeVisible();
    const systemPanelBox = await systemPanel.boundingBox();
    expect(systemPanelBox).not.toBeNull();
    expect(systemPanelBox!.y + systemPanelBox!.height).toBeLessThanOrEqual(746);
    await expect
      .poll(() => systemPanel.locator("[class*='systemPromptContent']").evaluate((element) => getComputedStyle(element).maxHeight))
      .not.toBe("none");
    await expectNoPageOverflow(page);
  });

  test("AC-RWD-12: mobile composer settings use a compact labeled grid", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openSession(page);

    await page.getByRole("button", { name: "More composer controls" }).click();
    const panel = page.locator("#composer-secondary-tools");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Composer", { exact: true })).toBeVisible();
    await expect(panel.getByText("Reasoning", { exact: true })).toBeVisible();
    await expect(panel.getByText("Tools", { exact: true })).toBeVisible();
    await expect(panel.getByText("Sound", { exact: true })).toBeVisible();

    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.width).toBeLessThanOrEqual(320);
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(320);
    const controlHeights = await panel.getByRole("button").evaluateAll((buttons) =>
      buttons
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((button) => button.getBoundingClientRect().height),
    );
    expect(controlHeights.length).toBeGreaterThanOrEqual(6);
    expect(Math.min(...controlHeights)).toBeGreaterThanOrEqual(44);
    await expectNoPageOverflow(page);
  });

  test("AC-RWD-13: narrow desktop file chrome stays compact and aligned", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSession(page);

    await page.getByRole("button", { name: "Explorer", exact: true }).click();
    await page.getByText("README.md", { exact: true }).click();
    await page.getByRole("button", { name: "Raw", exact: true }).click();

    const panel = page.locator(".right-panel-container.right-panel-open");
    const panelBar = page.getByTestId("right-panel-tab-bar");
    const tabs = panelBar.locator("[class*='tabBar']");
    const toolbar = page.getByTestId("file-viewer-toolbar");
    const actions = toolbar.locator("[class*='fileActions']");
    const [panelBox, tabsBox, toolbarBox, actionsBox] = await Promise.all([
      panel.boundingBox(),
      tabs.boundingBox(),
      toolbar.boundingBox(),
      actions.boundingBox(),
    ]);

    expect(panelBox).not.toBeNull();
    expect(tabsBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(tabsBox!.height).toBeLessThanOrEqual(36);
    expect(toolbarBox!.height).toBeLessThanOrEqual(70);
    expect(toolbarBox!.x).toBeGreaterThanOrEqual(panelBox!.x);
    expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
    expect(actionsBox!.x).toBeGreaterThanOrEqual(toolbarBox!.x);
    expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width);
    await expectNoPageOverflow(page);
  });

  test("AC-RWD-14: tablet operational panel clears the rail and keeps a 44px header", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openSession(page);

    await page.getByRole("button", { name: "Schedules", exact: true }).click();
    const rail = page.getByRole("navigation", { name: "Primary" });
    const panel = page.getByTestId("schedule-panel");
    const header = panel.locator(":scope > div").first();
    const [railBox, headerBox] = await Promise.all([
      rail.boundingBox(),
      header.boundingBox(),
    ]);

    expect(railBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    await expect.poll(async () => (await panel.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 1);
    expect(headerBox!.height).toBeLessThanOrEqual(44);
    await expectNoPageOverflow(page);
  });
});
