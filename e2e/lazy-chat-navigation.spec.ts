import { expect, test } from "@playwright/test";

const MAIN_ID = "aaaa1111-2222-3333-4444-555566667777";
const PARALLEL_ID = "ffff1111-2222-3333-4444-555566667777";

test("welcome defers conversation code and keeps navigation usable while it loads", async ({ page }) => {
  let releaseConversation = () => {};
  const conversationReady = new Promise<void>(resolve => { releaseConversation = resolve; });
  let conversationChunks = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  await page.route("**/_next/static/**/*.js", async route => {
    const response = await route.fetch();
    const body = await response.body();
    // The persisted bookmark key identifies ChatWindow after minification;
    // hashed chunk filenames and chunk counts change between builds.
    if (body.includes(Buffer.from("pi-bookmarks:"))) {
      conversationChunks++;
      await conversationReady;
    }
    await route.fulfill({ response, body });
  });

  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByTestId("welcome-screen")).toHaveAttribute("data-state", /^(welcome|project)$/);
    const session = page.locator(`[data-session-row="${MAIN_ID}"]`);
    await expect(session).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(conversationChunks).toBe(0);

    await session.click();
    await expect.poll(() => conversationChunks).toBeGreaterThan(0);
    await expect(page.getByRole("status").filter({ hasText: "Loading conversation…" })).toBeVisible();
    await expect(page.getByTestId("welcome-screen")).toHaveCount(0);
    await expect(page.getByRole("grid", { name: "Sessions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  } finally {
    releaseConversation();
  }

  const main = page.locator(`[data-chat-session-id="${MAIN_ID}"]`);
  await expect(main).toBeVisible({ timeout: 20_000 });
  const composer = main.getByTestId("composer-shell").locator("textarea");
  await expect(composer).toBeVisible();
  await composer.fill("Existing conversation draft — do not send");

  const parallelSession = page.locator(`[data-session-row="${PARALLEL_ID}"]`);
  await parallelSession.hover();
  await parallelSession.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Open in parallel", exact: true }).click();
  await expect(page.locator(`[data-chat-session-id="${PARALLEL_ID}"]`)).toBeVisible();
  await expect(main).toBeVisible();
  await expect(composer).toHaveValue("Existing conversation draft — do not send");
  expect(errors).toEqual([]);
});

test("a direct conversation URL downloads its code while session metadata is pending", async ({ page }) => {
  let releaseSessions = () => {};
  const sessionsReady = new Promise<void>(resolve => { releaseSessions = resolve; });
  let sessionsRequested = false;
  let conversationDownloaded = false;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/sessions", async route => {
    sessionsRequested = true;
    await sessionsReady;
    await route.continue();
  });
  await page.route("**/_next/static/**/*.js", async route => {
    const response = await route.fetch();
    const body = await response.body();
    if (body.includes(Buffer.from("pi-bookmarks:"))) conversationDownloaded = true;
    await route.fulfill({ response, body });
  });

  try {
    await page.goto(`/?session=${MAIN_ID}`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => sessionsRequested).toBe(true);
    await expect.poll(() => conversationDownloaded).toBe(true);
    await expect(page.getByTestId("welcome-screen")).toHaveAttribute("data-state", "loading");
    await expect(page.getByTestId("composer-shell")).toHaveCount(0);
  } finally {
    releaseSessions();
  }

  const conversation = page.locator(`[data-chat-session-id="${MAIN_ID}"]`);
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await expect(conversation).toContainText("第一步先把驗證邏輯抽到");
  await expect(conversation.getByTestId("composer-shell").locator("textarea")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a fresh welcome can load the new conversation composer directly", async ({ page }) => {
  const project = process.env.E2E_PROJECT_CWD!;
  let agentPosts = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/agent/")) agentPosts++;
  });
  await page.route("**/api/sessions", route => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/api/projects/discover", route => route.fulfill({ json: { repos: [{ name: "Lazy conversation fixture", path: project }] } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Start a conversation", exact: true }).click();
  await page.getByTestId("project-switcher").getByRole("option", { name: /Lazy conversation fixture/ }).click();
  const composer = page.getByTestId("composer-shell").locator("textarea");
  await expect(composer).toBeVisible();
  await composer.fill("New conversation draft — do not send");
  await expect(composer).toHaveValue("New conversation draft — do not send");
  await expect(page.locator("[data-chat-cwd]")).toHaveAttribute("data-chat-cwd", project);
  expect(agentPosts).toBe(0);
});
