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
