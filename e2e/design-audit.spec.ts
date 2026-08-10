import { expect, test, type Locator, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

type InterfaceStyle = "original" | "trae";

async function openMain(page: Page, style: InterfaceStyle, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((nextStyle) => {
    localStorage.setItem("pi-ui-style", nextStyle);
    localStorage.setItem("pi-skin", "trae");
    localStorage.setItem("pi-font-size", "default");
    localStorage.setItem("pi-font-family", "sans");
    localStorage.setItem("pi-density", "comfortable");
  }, style);
  await page.goto(MAIN);
  await expect(page.getByRole("textbox", { name: "Message…" })).toBeVisible({ timeout: 20_000 });
  if (width <= 700) {
    // A restored mobile session can intentionally reopen its last panel.
    // Normalize to the actual Chat page before auditing the transcript.
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.locator(".sidebar-container")).toHaveClass(/sidebar-closed/);
  }
}

async function expectNoPageOverflow(page: Page, context: string) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document, `${context}: document overflow`).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body, `${context}: body overflow`).toBeLessThanOrEqual(dimensions.viewport);
}

async function auditControls(page: Page, root: Locator, context: string, mobile: boolean) {
  const selector = [
    "button",
    "a[href]",
    "input:not([type='hidden'])",
    "textarea",
    "select",
    "[role='button']",
    "[role='option']",
    "[role='treeitem']",
    "[role='menuitem']",
    "[role='tab']",
    "[role='switch']",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const results = await root.locator(selector).evaluateAll((elements, isMobile) => elements.flatMap((element) => {
      const node = element as HTMLElement;
      const rect = node.getBoundingClientRect();
      const styles = getComputedStyle(node);
      if (styles.display === "none" || styles.visibility === "hidden" || Number(styles.opacity) === 0 || rect.width <= 0 || rect.height <= 0) return [];
      if (typeof node.checkVisibility === "function" && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return [];
      if (styles.pointerEvents === "none") return [];
      // CSS-translated mobile drawers are audited only after they open.
      if (rect.right <= 0 || rect.left >= window.innerWidth) return [];
      const labelledBy = node.getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      const labels = "labels" in element
        ? Array.from((element as HTMLInputElement).labels ?? []).map((label) => label.textContent?.trim() ?? "").join(" ")
        : "";
      const inputValue = element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)
        ? element.value
        : "";
      const name = [
        node.getAttribute("aria-label"),
        labelledBy,
        labels,
        node.getAttribute("title"),
        node.getAttribute("alt"),
        node.getAttribute("placeholder"),
        inputValue,
        node.innerText,
      ].find((value) => value?.trim())?.trim() ?? "";
      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute("role") ?? "";
      const disabled = node.matches(":disabled") || node.getAttribute("aria-disabled") === "true";
      const fontSize = Number.parseFloat(styles.fontSize) || 0;
      const lineHeight = styles.lineHeight === "normal" ? 0 : Number.parseFloat(styles.lineHeight) || 0;
      const radius = Number.parseFloat(styles.borderTopLeftRadius) || 0;
      const transitionMs = styles.transitionDuration.split(",").reduce((max, value) => {
        const trimmed = value.trim();
        const milliseconds = trimmed.endsWith("ms") ? Number.parseFloat(trimmed) : Number.parseFloat(trimmed) * 1_000;
        return Math.max(max, Number.isFinite(milliseconds) ? milliseconds : 0);
      }, 0);
      const fullyOnscreen = rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      for (let ancestor = node.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        const clipsX = /(auto|scroll|hidden|clip)/.test(ancestorStyle.overflowX);
        const clipsY = /(auto|scroll|hidden|clip)/.test(ancestorStyle.overflowY);
        const ancestorRect = ancestor.getBoundingClientRect();
        if ((clipsX && (centerX < ancestorRect.left || centerX > ancestorRect.right))
          || (clipsY && (centerY < ancestorRect.top || centerY > ancestorRect.bottom))) return [];
        // A list row cut by the current scrollport is a normal transient state;
        // the same component is audited when fully visible elsewhere in the list.
        if (clipsY && (rect.top < ancestorRect.top || rect.bottom > ancestorRect.bottom)) return [];
        // A fixed surface establishes the relevant viewport boundary; outer
        // app-shell overflow does not clip its portalled/fixed descendants.
        if (ancestorStyle.position === "fixed") break;
      }
      const hit = fullyOnscreen ? document.elementFromPoint(centerX, centerY) : null;
      const hittable = !fullyOnscreen || disabled || hit === node || node.contains(hit) || Boolean(hit?.contains(node));
      const hitDescription = hit instanceof HTMLElement
        ? `${hit.tagName.toLowerCase()}${typeof hit.className === "string" && hit.className ? `.${hit.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")}` : ""}`
        : "none";
      const buttonLike = tag === "button" || role === "button" || role === "option" || role === "switch";

      return [{
        name,
        tag,
        role,
        className: typeof node.className === "string" ? node.className : "",
        width: rect.width,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        fontSize,
        lineHeight,
        radius,
        transitionMs,
        hittable,
        hitDescription,
        tooSmall: buttonLike && (rect.width < (isMobile ? 43.5 : 23.5) || rect.height < (isMobile ? 43.5 : 23.5)),
      }];
    }), mobile);
  expect(results.length, `${context}: no controls found`).toBeGreaterThan(0);

  const failures: string[] = [];
  for (const result of results) {
    const classHint = result.className ? `.${result.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")}` : "";
    const id = `${result.tag}${result.role ? `[role=${result.role}]` : ""}${classHint} ${JSON.stringify(result.name || "unnamed")}`;
    if (!result.name) failures.push(`${id}: missing accessible name`);
    const verticallyVisible = result.bottom > 0 && result.top < page.viewportSize()!.height;
    if (verticallyVisible && (result.left < -1 || result.right > page.viewportSize()!.width + 1)) {
      failures.push(`${id}: horizontally clipped (${result.left.toFixed(1)}..${result.right.toFixed(1)})`);
    }
    if (!result.hittable) {
      failures.push(`${id}: covered at its center point by ${result.hitDescription} (${result.left.toFixed(1)},${result.top.toFixed(1)} ${result.width.toFixed(1)}×${result.height.toFixed(1)})`);
    }
    if (result.tooSmall) failures.push(`${id}: ${mobile ? "touch" : "pointer"} target ${result.width.toFixed(1)}×${result.height.toFixed(1)} is below ${mobile ? "44" : "24"}px`);
    if (result.fontSize > 0 && result.fontSize < 10) failures.push(`${id}: text is only ${result.fontSize}px`);
    if (result.lineHeight > 0 && result.fontSize > 0 && result.lineHeight + 0.1 < result.fontSize) {
      failures.push(`${id}: ${result.lineHeight}px line-height clips ${result.fontSize}px text`);
    }
    if (result.radius < 900 && result.radius > Math.min(result.width, result.height) / 2 + 1) {
      failures.push(`${id}: ${result.radius}px corner radius exceeds its ${result.width.toFixed(1)}×${result.height.toFixed(1)} bounds`);
    }
    if (result.transitionMs > 400) failures.push(`${id}: interaction transition lasts ${result.transitionMs}ms`);
  }

  expect(failures, `${context}\n${failures.join("\n")}`).toEqual([]);
  await auditTypography(root, context);
  await expectNoPageOverflow(page, context);
}

async function auditTypography(root: Locator, context: string) {
  const results = await root.locator("*").evaluateAll((elements) => elements.flatMap((element) => {
    if (!(element instanceof HTMLElement)) return [];
    if (element.closest('[aria-hidden="true"]')) return [];
    const directText = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!directText || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName)) return [];
    const rect = element.getBoundingClientRect();
    const styles = getComputedStyle(element);
    if (styles.display === "none" || styles.visibility === "hidden" || Number(styles.opacity) === 0 || rect.width <= 0 || rect.height <= 0) return [];
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return [];
    for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const ancestorRect = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(ancestorStyle.overflowY)
        && (rect.top < ancestorRect.top || rect.bottom > ancestorRect.bottom)) return [];
      if (/(auto|scroll|hidden|clip)/.test(ancestorStyle.overflowX)
        && (rect.left < ancestorRect.left || rect.right > ancestorRect.right)) return [];
      if (ancestorStyle.position === "fixed") break;
    }
    const fontSize = Number.parseFloat(styles.fontSize) || 0;
    if (fontSize === 0) return [];
    const lineHeight = styles.lineHeight === "normal" ? 0 : Number.parseFloat(styles.lineHeight) || 0;
    const fontWeight = Number.parseInt(styles.fontWeight, 10) || 0;
    const letterSpacing = styles.letterSpacing === "normal" ? 0 : Number.parseFloat(styles.letterSpacing) || 0;
    const horizontalClip = element.scrollWidth > element.clientWidth + 1
      && /(hidden|clip)/.test(styles.overflowX)
      && styles.textOverflow !== "ellipsis";
    const verticalClip = element.scrollHeight > element.clientHeight + 1
      && /(hidden|clip)/.test(styles.overflowY)
      && styles.getPropertyValue("-webkit-line-clamp") === "none";
    return [{
      tag: element.tagName.toLowerCase(),
      className: element.className,
      text: directText.slice(0, 80),
      fontFamily: styles.fontFamily,
      fontSize,
      lineHeight,
      fontWeight,
      letterSpacing,
      symbolOnly: /^[\p{P}\p{S}\s]+$/u.test(directText),
      horizontalClip,
      verticalClip,
    }];
  }));

  const failures: string[] = [];
  for (const result of results) {
    const classHint = typeof result.className === "string" && result.className
      ? `.${result.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")}`
      : "";
    const id = `${result.tag}${classHint} ${JSON.stringify(result.text)}`;
    if (!/(Inter|JetBrains Mono|Noto Sans TC|system-ui|-apple-system|Segoe UI)/.test(result.fontFamily)) {
      failures.push(`${id}: unexpected font stack ${result.fontFamily}`);
    }
    if (result.fontSize < 10) failures.push(`${id}: text is only ${result.fontSize}px`);
    if (![400, 500, 600, 700].includes(result.fontWeight)) failures.push(`${id}: unsupported rendered weight ${result.fontWeight}`);
    if (!result.symbolOnly && result.lineHeight > 0 && result.lineHeight + 0.1 < result.fontSize * 1.05) {
      failures.push(`${id}: ${result.lineHeight}px line-height is too tight for ${result.fontSize}px text`);
    }
    if (Math.abs(result.letterSpacing) > Math.max(1.5, result.fontSize * 0.1)) {
      failures.push(`${id}: ${result.letterSpacing}px letter spacing is excessive`);
    }
    if (result.horizontalClip) failures.push(`${id}: horizontally clips text without ellipsis`);
    if (result.verticalClip) failures.push(`${id}: vertically clips text without line clamp`);
  }
  expect(failures, `${context} typography\n${failures.join("\n")}`).toEqual([]);
}

async function openPrimaryView(page: Page, name: string, mobile: boolean) {
  if (mobile) {
    const backdrop = page.locator("button[class*='mobileSheetBackdrop']");
    if (await backdrop.isVisible()) {
      await page.keyboard.press("Escape");
      await expect(backdrop).toHaveCount(0);
    }
  }
  if (!mobile) {
    const trigger = page.getByRole("button", { name, exact: true }).last();
    if (await trigger.getAttribute("aria-pressed") === "true") return;
  }
  if (mobile && ["Sessions", "Files", "Search"].includes(name)) {
    const trigger = page.locator("nav[class*='mobileNav']").getByRole("button", { name, exact: true });
    if (await trigger.getAttribute("aria-current") === "page") return;
  }
  if (mobile && !["Sessions", "Files", "Search"].includes(name)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    const sheet = page.locator("section[class*='mobileMoreSheet']");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name, exact: true }).click();
    await expect(sheet).toHaveCount(0);
    return;
  }
  if (mobile) {
    await page.locator("nav[class*='mobileNav']").getByRole("button", { name, exact: true }).click();
  } else {
    await page.getByRole("button", { name, exact: true }).last().click();
  }
}

test("bundled typefaces and every readability preference render consistently", async ({ page }) => {
  test.setTimeout(120_000);
  const sizes = ["small", "default", "large", "xlarge"] as const;
  const renderedSizes: number[] = [];
  for (const size of sizes) {
    await page.addInitScript((nextSize) => {
      localStorage.setItem("pi-font-size", nextSize);
      localStorage.setItem("pi-font-family", "sans");
    }, size);
    await page.goto(MAIN);
    await expect(page.getByRole("textbox", { name: "Message…" })).toBeVisible();
    renderedSizes.push(await page.locator("body").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)));
    await expectNoPageOverflow(page, `font-size/${size}`);
  }
  expect(renderedSizes).toEqual([...renderedSizes].sort((a, b) => a - b));
  expect(new Set(renderedSizes).size).toBe(sizes.length);

  const families = [
    { value: "sans", expected: "Inter" },
    { value: "mono", expected: "JetBrains Mono" },
    { value: "system", expected: "Noto Sans TC" },
  ] as const;
  for (const family of families) {
    await page.addInitScript((nextFamily) => {
      localStorage.setItem("pi-font-size", "default");
      localStorage.setItem("pi-font-family", nextFamily);
    }, family.value);
    await page.goto(MAIN);
    await expect(page.getByRole("textbox", { name: "Message…" })).toBeVisible();
    const rendered = await page.evaluate(async () => {
      await document.fonts.ready;
      const [interFaces, monoFaces, traditionalChineseFaces] = await Promise.all([
        document.fonts.load('400 14px "Inter"', "Interface 123"),
        document.fonts.load('400 14px "JetBrains Mono"', "code_123"),
        document.fonts.load('400 14px "Noto Sans TC"', "繁體中文臺灣龍門"),
      ]);
      const body = getComputedStyle(document.body).fontFamily;
      const code = getComputedStyle(document.querySelector("code, pre, .chrome-mono") ?? document.body).fontFamily;
      return {
        body,
        code,
        inter: interFaces.length > 0 && document.fonts.check('400 14px "Inter"', "Interface 123"),
        mono: monoFaces.length > 0 && document.fonts.check('400 14px "JetBrains Mono"', "code_123"),
        traditionalChinese: traditionalChineseFaces.length > 0
          && document.fonts.check('400 14px "Noto Sans TC"', "繁體中文臺灣龍門"),
      };
    });
    expect(rendered.body).toContain(family.expected);
    expect(rendered.code).toContain("JetBrains Mono");
    expect(rendered).toMatchObject({ inter: true, mono: true, traditionalChinese: true });
  }
});

test("XL mono Traditional Chinese reflows at phone, tablet, and desktop widths", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem("pi-ui-style", "trae");
    localStorage.setItem("pi-skin", "trae");
    localStorage.setItem("pi-font-size", "xlarge");
    localStorage.setItem("pi-font-family", "mono");
    localStorage.setItem("pi-locale", "zh");
    localStorage.setItem("pi-density", "comfortable");
  });

  for (const viewport of [
    { width: 320, height: 800 },
    { width: 840, height: 889 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(MAIN);
    await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
    if (viewport.width <= 700) {
      await page.getByRole("button", { name: "對話", exact: true }).click();
      await expect(page.locator(".sidebar-container")).toHaveClass(/sidebar-closed/);
    }

    const root = page.getByTestId("app-shell");
    await auditControls(page, root, `high-risk/${viewport.width}/xl-mono-zh`, viewport.width <= 700);
    await expectNoPageOverflow(page, `high-risk/${viewport.width}/xl-mono-zh`);
  }
});

test("Original and TRAE share one semantic radius contract with distinct geometry", async ({ browser }) => {
  const expected = {
    original: {
      inline: 3,
      controlCompact: 4,
      control: 6,
      controlProminent: 8,
      row: 6,
      card: 8,
      menu: 8,
      panel: 12,
      dialog: 16,
      composer: 12,
      message: 12,
      messageTail: 4,
      media: 8,
    },
    trae: {
      inline: 5,
      controlCompact: 7,
      control: 10,
      controlProminent: 14,
      row: 10,
      card: 14,
      menu: 14,
      panel: 18,
      dialog: 22,
      composer: 18,
      message: 18,
      messageTail: 7,
      media: 14,
    },
  } as const;

  for (const style of ["original", "trae"] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await openMain(page, style, 1440, 900);
      const measured = await page.evaluate(() => {
        const tokenNames = [
          "inline",
          "control-compact",
          "control",
          "control-prominent",
          "row",
          "card",
          "menu",
          "panel",
          "dialog",
          "composer",
          "message",
          "message-tail",
          "media",
        ] as const;
        const values = Object.fromEntries(tokenNames.map((name) => {
          const probe = document.createElement("div");
          probe.style.cssText = `position:fixed;width:100px;height:100px;border-radius:var(--radius-${name})`;
          document.body.appendChild(probe);
          const radius = Number.parseFloat(getComputedStyle(probe).borderTopLeftRadius);
          probe.remove();
          return [name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), radius];
        }));
        const radiusOf = (selector: string) => {
          const element = document.querySelector(selector);
          return element ? Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) : -1;
        };
        return {
          ...values,
          railButton: radiusOf("[class*='railButton']"),
          sessionCard: radiusOf("[role='option'][aria-selected='true']"),
          composerSurface: radiusOf("[class*='inputWrapper']"),
        };
      });

      expect(measured).toMatchObject(expected[style]);
      expect(measured.railButton).toBe(expected[style].controlCompact);
      expect(measured.sessionCard).toBe(expected[style].row);
      expect(measured.composerSurface).toBe(expected[style].composer);

      await page.getByRole("button", { name: "Token usage and cost report" }).last().click();
      const analytics = page.getByRole("dialog", { name: "Session Analytics" });
      await expect(analytics).toBeVisible();
      expect(Number.parseFloat(await analytics.evaluate((element) => getComputedStyle(element).borderTopLeftRadius)))
        .toBe(expected[style].dialog);
    } finally {
      await context.close().catch(() => {});
    }
  }
});

async function auditMainSurfaces(page: Page, style: InterfaceStyle, mobile: boolean) {
  const viewport = mobile ? "mobile" : "desktop";
  const chat = page.getByTestId("top-bar").locator("..");
  await auditControls(page, chat, `${style}/${viewport}/chat`, mobile);
  await auditControls(page, page.getByRole("navigation", { name: "Primary" }), `${style}/${viewport}/navigation`, mobile);

  const panels = [
    { button: "Sessions", testId: undefined },
    { button: "Agents", testId: "agent-dashboard" },
    { button: "Schedules", testId: "schedule-panel" },
    { button: mobile ? "Files" : "Explorer", testId: undefined },
    { button: "Search", testId: "unified-search" },
    { button: "Changes", testId: undefined },
    { button: mobile ? "tGD" : "tGD artifacts", testId: undefined },
  ];

  for (const panel of panels) {
    await openPrimaryView(page, panel.button, mobile);
    if (panel.testId) await expect(page.getByTestId(panel.testId)).toBeVisible();
    if (panel.button === "Explorer" || panel.button === "Files") {
      await expect(page.getByText("README.md", { exact: true })).toBeVisible({ timeout: 10_000 });
    }
    const openPanel = page.locator(".sidebar-container.sidebar-open");
    await expect(openPanel, `${panel.button} panel`).toBeVisible();
    await expect.poll(async () => (await openPanel.boundingBox())?.x ?? -999).toBeGreaterThanOrEqual(-1);
    if (!mobile) {
      const settledWidth = panel.button === "Agents" || panel.button === "Schedules"
        ? 340
        : panel.button === "Explorer" || panel.button === "Search"
          ? 300
          : 260;
      // Desktop panels animate between their compact and operational widths.
      // Audit only after the clip boundary reaches its final width, otherwise
      // valid controls can be filtered as transiently outside overflow: clip.
      await expect.poll(async () => (await openPanel.boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(settledWidth - 1);
    }
    await auditControls(page, openPanel, `${style}/${viewport}/${panel.button}`, mobile);
  }

  // Safe create forms expose controls not present in their empty/list states.
  await openPrimaryView(page, "Agents", mobile);
  await page.getByTestId("agent-new-run").click();
  const agentEditor = page.getByTestId("agent-run-editor");
  await expect(agentEditor).toBeVisible();
  await auditControls(page, agentEditor, `${style}/${viewport}/new-agent`, mobile);
  await agentEditor.getByRole("button", { name: "Back to agents", exact: true }).click();

  await openPrimaryView(page, "Schedules", mobile);
  await page.getByRole("button", { name: "New schedule", exact: true }).first().click();
  const scheduleEditor = page.getByTestId("schedule-editor");
  await expect(scheduleEditor).toBeVisible();
  await auditControls(page, scheduleEditor, `${style}/${viewport}/new-schedule`, mobile);
  await scheduleEditor.getByRole("button", { name: "Cancel", exact: true }).click();

  // Settings and analysis surfaces are modal/sheet states over the main shell.
  const modals = [
    { label: "Analytics", desktopTrigger: "Token usage and cost report", dialog: "Session Analytics" },
    { label: "Models", desktopTrigger: /^Models/, dialog: "Models" },
    { label: "Skills", desktopTrigger: /^Skills/, dialog: "Skills" },
    { label: "Extensions", desktopTrigger: "Extensions", dialog: "Extensions" },
    { label: "Appearance", desktopTrigger: "Appearance", dialog: "Appearance" },
  ] as const;
  for (const modal of modals) {
    if (mobile) await page.getByRole("button", { name: "More", exact: true }).click();
    const triggerName = mobile ? modal.label : modal.desktopTrigger;
    await page.getByRole("button", { name: triggerName, exact: typeof triggerName === "string" }).last().click();
    const dialog = page.getByRole("dialog", { name: modal.dialog });
    await expect(dialog, `${modal.label} dialog`).toBeVisible();
    await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    await auditControls(page, dialog, `${style}/${viewport}/${modal.label}`, mobile);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }

  // The repo/branch identity is itself a navigation control.
  if (mobile) {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.locator(".sidebar-container")).toHaveClass(/sidebar-closed/);
  }
  await page.getByTestId("session-identity").getByRole("button").click();
  const projectSwitcher = page.getByTestId("project-switcher");
  await expect(projectSwitcher).toBeVisible();
  await auditControls(page, projectSwitcher, `${style}/${viewport}/project-switcher`, mobile);
  await page.keyboard.press("Escape");
}

for (const style of ["original", "trae"] as const) {
  test(`${style}: desktop pages and safe controls stay usable`, async ({ page }) => {
    test.setTimeout(120_000);
    await openMain(page, style, 1440, 900);
    await auditMainSurfaces(page, style, false);
  });

  test(`${style}: mobile pages and safe controls stay usable`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      await openMain(page, style, 390, 844);
      await auditMainSurfaces(page, style, true);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test(`${style}: login page has a complete mobile and desktop form`, async ({ page }) => {
    for (const viewport of [{ width: 320, height: 800 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.addInitScript((nextStyle) => localStorage.setItem("pi-ui-style", nextStyle), style);
      await page.goto("/login");
      const form = page.locator("form");
      await expect(page.getByRole("textbox", { name: "Access password" })).toBeVisible();
      await auditControls(page, form, `${style}/login/${viewport.width}`, viewport.width < 700);
    }
  });
}
