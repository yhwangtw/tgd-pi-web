import { expect, test, type Page } from "@playwright/test";

const project = () => process.env.E2E_PROJECT_CWD!;
async function emptyInstallation(page: Page) {
  await page.route("**/api/sessions", route => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/api/projects/discover", route => route.fulfill({ json: { repos: [{ name: "New flow fixture", path: project() }] } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Start a conversation", exact: true })).toBeVisible();
}
const composer = (page: Page) => page.getByTestId("composer-shell").locator("textarea");

for (const style of ["original", "trae"]) for (const width of [390, 1440]) {
  test(`${style} ${width}: New works without history and selecting a project opens the composer`, async ({ page }, info) => {
    await page.addInitScript(style => { localStorage.setItem("pi-ui-style", style); localStorage.setItem("pi-locale", "en"); }, style);
    await page.setViewportSize({ width, height: 900 });
    let agentPosts = 0;
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/agent/")) agentPosts++; });
    await emptyInstallation(page);
    const welcome = page.getByTestId("welcome-screen");
    await expect(welcome).toHaveAttribute("data-state", "welcome");
    await expect(welcome.getByRole("button", { name: "Start a conversation", exact: true })).toBeInViewport();
    await expect(welcome.getByRole("button", { name: "Models", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("first-arrival.png"), animations: "disabled" });
    await welcome.getByRole("button", { name: "Models", exact: true }).click();
    const models = page.getByTestId("models-config-dialog");
    await expect(models).toBeVisible();
    await models.getByRole("button", { name: "Close", exact: true }).click();
    await expect(models).toBeHidden();
    await expect(welcome).toBeVisible();
    if (width < 700) await page.getByRole("button", { name: "Sessions", exact: true }).last().click();
    const newButton = page.getByRole("button", { name: "New", exact: true });
    await expect(newButton).toBeEnabled();
    await newButton.click();
    const picker = page.getByTestId("project-switcher");
    await expect(picker).toBeVisible();
    await picker.getByRole("option", { name: /New flow fixture/ }).click();
    await expect(picker).toBeHidden();
    await expect(composer(page)).toBeVisible();
    if (width < 700) {
      await expect.poll(() => page.locator(".sidebar-container").evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    }
    await composer(page).fill("New conversation draft — do not send");
    expect(agentPosts).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("new-conversation.png"), animations: "disabled" });
  });
}

test("welcome action validates a typed path, shows errors and then starts automatically", async ({ page }) => {
  await emptyInstallation(page);
  await page.getByRole("button", { name: "Start a conversation", exact: true }).click();
  const picker = page.getByTestId("project-switcher");
  const input = picker.getByRole("textbox");
  await input.fill(`${project()}/does-not-exist`);
  await input.press("Enter");
  await expect(picker.getByRole("alert")).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
  await input.fill(project());
  await input.press("Enter");
  await expect(composer(page)).toBeVisible();
  await expect(picker).toBeHidden();
});

test("default directory errors remain retryable and success starts without a second New", async ({ page }) => {
  let calls = 0;
  // Exercise UI handling without creating a default directory in the host home.
  await page.route("**/api/default-cwd", route => {
    calls++;
    return route.fulfill(calls === 1 ? { status: 500, json: { error: "Cannot create test directory" } } : { json: { cwd: project() } });
  });
  await emptyInstallation(page);
  await page.getByRole("button", { name: "Start a conversation", exact: true }).click();
  const picker = page.getByTestId("project-switcher");
  await picker.getByRole("button", { name: "Use default directory" }).click();
  await expect(picker.getByRole("alert")).toHaveText("Cannot create test directory");
  await picker.getByRole("button", { name: "Use default directory" }).click();
  await expect(composer(page)).toBeVisible();
  expect(calls).toBe(2);
});

test("cancelled New does not carry into a normal project switch", async ({ page }) => {
  await emptyInstallation(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  const picker = page.getByTestId("project-switcher");
  await picker.getByRole("textbox").press("Escape");
  await expect(picker).toBeHidden();
  await page.keyboard.press("Control+p");
  await picker.getByRole("option", { name: /New flow fixture/ }).click();
  await expect(composer(page)).toHaveCount(0);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(composer(page)).toBeVisible();
  await expect(picker).toBeHidden();
});

test("command palette New also guides an empty installation", async ({ page }) => {
  await emptyInstallation(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Unified search", exact: true }).fill("New session");
  await page.getByRole("button", { name: /^New Session / }).click();
  const picker = page.getByTestId("project-switcher");
  await expect(picker).toBeVisible();
  await picker.getByRole("option", { name: /New flow fixture/ }).click();
  await expect(composer(page)).toBeVisible();
});


for (const style of ["original", "trae"] as const) for (const width of [320, 883, 1440]) {
  test(`${style} ${width}: new-chat header aligns to the composer at large text sizes`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(style => {
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-locale", "en");
      localStorage.setItem("pi-font-size", "xlarge");
    }, style);
    await emptyInstallation(page);
    await page.getByRole("button", { name: "Start a conversation", exact: true }).click();
    await page.getByTestId("project-switcher").getByRole("option", { name: /New flow fixture/ }).click();
    const header = page.getByTestId("new-chat-welcome");
    const surface = page.getByTestId("composer-toolbar");
    await expect(header).toBeVisible();
    await expect(surface).toBeVisible();
    const [a, b] = await Promise.all([header.boundingBox(), surface.boundingBox()]);
    expect(a).not.toBeNull(); expect(b).not.toBeNull();
    expect(Math.abs(a!.x - b!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(a!.width - b!.width)).toBeLessThanOrEqual(1);
    expect(b!.y - (a!.y + a!.height)).toBeGreaterThanOrEqual(12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width > 700) {
      const labels = await header.getByTestId("welcome-versions").locator("span > span").count();
      expect(labels).toBe(2);
      const textRows = await header.getByTestId("welcome-versions").evaluate(element => [...element.children].map(child => child.getBoundingClientRect().y));
      expect(Math.abs(textRows[0] - textRows[1])).toBeLessThanOrEqual(1);
    }
    await composer(page).fill("Keep this draft while opening models");
    const modelSelector = page.getByTestId("model-selector-trigger");
    await expect(modelSelector).toHaveAttribute("data-catalog-status", "ready");
    await modelSelector.click();
    await page.getByRole("dialog", { name: "Choose a model", exact: true }).getByRole("searchbox").press("Escape");
    await expect(composer(page)).toHaveValue("Keep this draft while opening models");
    await page.screenshot({ path: info.outputPath("welcome-composer-aligned.png"), animations: "disabled" });
  });
}

test("slow first arrival shows a loading state and only offers Start after restoration", async ({ page }) => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/sessions", async route => { await gate; await route.fulfill({ json: { sessions: [] } }); });
  try {
    await page.goto("/");
    const loading = page.getByTestId("welcome-screen");
    await expect(loading).toHaveAttribute("data-state", "loading");
    await expect(loading.getByRole("status")).toHaveText("Loading your workspace…");
    await expect(loading.getByRole("button")).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByTestId("welcome-screen")).toHaveAttribute("data-state", "welcome");
  await expect(page.getByRole("button", { name: "Start a conversation", exact: true })).toBeVisible();
});


test("a selected project offers a direct Start without losing the chosen folder", async ({ page }) => {
  await emptyInstallation(page);
  await page.keyboard.press("Control+p");
  await page.getByTestId("project-switcher").getByRole("option", { name: /New flow fixture/ }).click();
  const welcome = page.getByTestId("welcome-screen");
  await expect(welcome).toHaveAttribute("data-state", "project");
  const folder = welcome.locator("details");
  const fullPath = welcome.getByTestId("welcome-project-path");
  await expect(fullPath).toBeHidden();
  await folder.locator("summary").press("Enter");
  await expect(fullPath).toBeVisible();
  await expect(fullPath).toHaveText(project());
  await folder.locator("summary").press("Enter");
  await expect(fullPath).toBeHidden();
  await expect(composer(page)).toHaveCount(0);
  await welcome.getByRole("button", { name: "Start a conversation", exact: true }).click();
  await expect(composer(page)).toBeVisible();
  await expect(page.getByTestId("project-switcher")).toBeHidden();
  await expect(page.locator("[data-chat-cwd]")).toHaveAttribute("data-chat-cwd", project());
});
