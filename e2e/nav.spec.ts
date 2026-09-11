import { test, expect, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
const PROJECT_CWD = process.env.E2E_PROJECT_CWD!;

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function openMain(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
}

async function openFiles(page: Page) {
  const explorerButton = page.getByRole("button", { name: "Explorer", exact: true });
  await expect(explorerButton).toBeVisible();
  await explorerButton.click();
  await expect(page.getByText("README.md", { exact: true })).toBeVisible();
}

test.describe("left rail", () => {
  test("finds conversations across projects without switching folders first", async ({ page }) => {
    await openMain(page);

    const sessionList = page.getByRole("listbox", { name: "Sessions" });
    const scope = page.getByRole("group", { name: "Conversation scope" });
    const search = page.getByRole("textbox", { name: "Search conversations" });

    await expect(scope.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(sessionList.getByText("跨專案歷史對話", { exact: true })).toBeVisible();
    await expect(sessionList.getByText("archive-project", { exact: true })).toBeVisible();

    await search.fill("billing migration");
    await expect(sessionList.getByText("跨專案歷史對話", { exact: true })).toBeVisible({ timeout: 10_000 });

    await scope.getByRole("button", { name: "This project", exact: true }).click();
    await expect(scope.getByRole("button", { name: "This project", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(sessionList.getByText("跨專案歷史對話", { exact: true })).toHaveCount(0);
  });

  test("keeps conversation discovery usable on a phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMain(page);
    await page.locator("nav[class*='mobileNav']").getByRole("button", { name: "Sessions", exact: true }).click();

    const search = page.getByRole("textbox", { name: "Search conversations" });
    const allScope = page.getByRole("button", { name: "All", exact: true });
    const projectScope = page.getByRole("button", { name: "This project", exact: true });
    await expect(search).toBeVisible();
    await expect(allScope).toBeVisible();
    await expect(projectScope).toBeVisible();

    const [searchBox, allBox, projectBox] = await Promise.all([
      search.boundingBox(),
      allScope.boundingBox(),
      projectScope.boundingBox(),
    ]);
    expect(searchBox?.height).toBeGreaterThanOrEqual(44);
    expect(allBox?.height).toBeGreaterThanOrEqual(44);
    expect(projectBox?.height).toBeGreaterThanOrEqual(44);

    await search.fill("billing migration");
    await expect(page.getByRole("listbox", { name: "Sessions" }).getByText("跨專案歷史對話", { exact: true })).toBeVisible({ timeout: 10_000 });

    const width = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(width.document).toBeLessThanOrEqual(width.viewport);
    expect(width.body).toBeLessThanOrEqual(width.viewport);
  });

  test("uses one Search entry and opens the same panel with Command-K", async ({ page }) => {
    await openMain(page);

    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Command palette (⌘K)", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Search", exact: true }).click();
    const search = page.getByTestId("unified-search");
    await expect(search).toBeVisible();
    await expect(search.getByRole("textbox", { name: "Unified search" })).toBeFocused();
    for (const scope of ["All", "Sessions", "Files", "Content", "Commands"]) {
      await expect(search.getByRole("button", { name: scope, exact: true })).toBeVisible();
    }
    const scopes = search.locator("[class*='scopes']");
    const [searchBox, scopesBox] = await Promise.all([search.boundingBox(), scopes.boundingBox()]);
    expect(searchBox).not.toBeNull();
    expect(scopesBox).not.toBeNull();
    for (const scope of ["All", "Sessions", "Files", "Content", "Commands"]) {
      const box = await search.getByRole("button", { name: scope, exact: true }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(scopesBox!.x - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(scopesBox!.x + scopesBox!.width + 1);
    }

    await openFiles(page);
    await expect(page.getByPlaceholder("Filter files…")).toHaveCount(0);

    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await expect(search).toBeVisible();
    await expect(search.getByRole("textbox", { name: "Unified search" })).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  });

  test("groups session, filename, content, and command results in one panel", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const search = page.getByTestId("unified-search");
    const input = search.getByRole("textbox", { name: "Unified search" });

    await input.fill("index");
    await search.getByRole("button", { name: "Files", exact: true }).click();
    await expect(search.getByText("src/index.ts", { exact: true })).toBeVisible({ timeout: 10_000 });

    await search.getByRole("button", { name: "Content", exact: true }).click();
    await input.fill("answer");
    await expect(search.getByText(/export const answer/).first()).toBeVisible({ timeout: 10_000 });

    await search.getByRole("button", { name: "Sessions", exact: true }).click();
    await input.fill("God class");
    await expect(search.getByText("專案架構分析", { exact: true })).toBeVisible({ timeout: 10_000 });

    await search.getByRole("button", { name: "Commands", exact: true }).click();
    await input.fill("Models");
    await expect(search.getByRole("button", { name: /Open Models/ })).toBeVisible();
  });
});

test.describe("file explorer", () => {
  test("git badges on modified/untracked files and dirty-dir dots", async ({ page }) => {
    await openMain(page);
    await openFiles(page);
    // src is committed but contains a modified file → dirty dot on the dir;
    // expanding shows index.ts with an M badge; untracked files show U.
    await page.getByText("src", { exact: true }).first().click();
    await expect(page.locator("text=/^M$/").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=/^U$/").first()).toBeVisible();
  });

  test("unified search finds nested files and shows relative paths", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const search = page.getByTestId("unified-search");
    await search.getByRole("textbox", { name: "Unified search" }).fill("index");
    await search.getByRole("button", { name: "Files", exact: true }).click();
    await expect(search.getByText("src/index.ts", { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test("context menu: copy relative path / mention / diff entries", async ({ page }) => {
    // Open the menu before Git metadata arrives. It must react to the current
    // status, not keep the empty snapshot captured by the right-click.
    let releaseGit!: () => void;
    const gitReady = new Promise<void>(resolve => { releaseGit = resolve; });
    await page.route("**/api/git/changes?**", async route => { await gitReady; await route.continue(); });
    await openMain(page);
    await openFiles(page);
    await page.getByText("src", { exact: true }).first().click();
    const hit = page.locator("[data-fx-row]").filter({ hasText: "index.ts" }).first();
    await expect(hit).toBeVisible({ timeout: 10_000 });
    await hit.click({ button: "right" });

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Insert @ mention" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "View diff" })).toHaveCount(0);
    releaseGit();
    await expect(menu.getByRole("menuitem", { name: "View diff" })).toBeVisible();

    await menu.getByRole("menuitem", { name: "Copy relative path" }).click();
    await expect(menu).toHaveCount(0);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    expect(clip).toBe("src/index.ts");
  });

  test("keyboard navigation moves focus across rows", async ({ page }) => {
    await openMain(page);
    await openFiles(page);
    const first = page.locator("[data-fx-row]").first();
    await first.click();
    await page.keyboard.press("ArrowDown");
    const focusedIsRow = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.hasAttribute("data-fx-row") ?? false,
    );
    expect(focusedIsRow).toBe(true);
  });
});

test.describe("project switcher", () => {
  test("trigger opens the modal; rows carry session counts", async ({ page }) => {
    await openMain(page);
    await page.getByTestId("project-switcher-trigger").click();
    const modal = page.getByTestId("project-switcher");
    await expect(modal).toBeVisible();
    const row = modal.locator("[role=option]").filter({ hasText: "demo-project" }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("session");
  });

  test("search filters rows; Enter picks the highlighted project", async ({ page }) => {
    await openMain(page);
    await page.getByTestId("project-switcher-trigger").click();
    const input = page.getByTestId("project-switcher").locator("input");
    await input.pressSequentially("demo");
    await expect(page.getByTestId("project-switcher").locator("[role=option]").first()).toContainText("demo-project");
    await input.press("Enter");
    await expect(page.getByTestId("project-switcher")).toHaveCount(0);
    await expect(page.getByTestId("project-switcher-trigger")).toContainText("demo-project");
  });

  test("typing a path switches to path mode with directory completion", async ({ page }) => {
    await openMain(page);
    await page.getByTestId("project-switcher-trigger").click();
    const input = page.getByTestId("project-switcher").locator("input");
    // Type the fixture project path minus its last few characters
    const partial = PROJECT_CWD.slice(0, -4);
    await input.fill(partial);
    const suggestion = page.getByTestId("path-completion-option").filter({ hasText: "demo-project" }).first();
    await expect(suggestion).toBeVisible({ timeout: 10_000 });
    // Tab completes to the highlighted dir
    await input.press("Tab");
    await expect(input).toHaveValue(new RegExp("demo-project(-tGD|-wt)?/$"));
    // Enter commits the typed path as the project cwd
    await input.fill(PROJECT_CWD);
    await input.press("Enter");
    await expect(page.getByTestId("project-switcher")).toHaveCount(0);
    await expect(page.getByTestId("project-switcher-trigger")).toContainText("demo-project");
  });
});
