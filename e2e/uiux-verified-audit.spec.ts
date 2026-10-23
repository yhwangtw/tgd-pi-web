import { expect, test, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
async function open(page: Page, width = 1440, style = "trae") {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(style => { localStorage.setItem("pi-ui-style", style); localStorage.setItem("pi-locale", "en"); }, style);
  await page.route("**/api/projects/discover", route => route.fulfill({ json: { repos: [] } }));
  await page.goto(MAIN);
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
  if (width <= 700) await page.getByRole("button", { name: "Chat", exact: true }).click();
}

test("project hiding has an undo and a persistent restore entry; keyboard focus stays in the dialog", async ({ page }) => {
  // Give the picker a second fixture project: the currently selected project
  // intentionally has no Hide action. Do not depend on real home discovery.
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.sessions.push({ ...data.sessions[0], id: "uiux-hidden-project", cwd: `${process.env.E2E_PROJECT_CWD}/src`, name: "Hidden project fixture" });
    await route.fulfill({ response, json: data });
  });
  await open(page);
  const trigger = page.getByTestId("project-switcher-trigger");
  await trigger.click();
  const dialog = page.getByTestId("project-switcher");
  await expect(dialog).toBeVisible();
  const projectRow = dialog.getByTitle(`${process.env.E2E_PROJECT_CWD}/src`, { exact: true });
  const hide = projectRow.getByRole("button", { name: "Hide from list", exact: true });
  await projectRow.hover();
  await hide.click();
  await expect(dialog.getByRole("status")).toContainText("Hidden");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("pi-cwd-hidden")!).length)).toBe(1);
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("pi-cwd-hidden")!).length)).toBe(0);
  await projectRow.hover();
  await hide.click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.locator("summary").filter({ hasText: "Hidden projects" }).click();
  await dialog.getByRole("button", { name: /^Restore:/ }).click();
  await expect(dialog.locator("summary")).toHaveCount(0);
  const input = dialog.getByRole("textbox");
  await input.fill(process.env.E2E_PROJECT_CWD!.slice(0, -4));
  await expect(dialog.getByTestId("path-completion-option").first()).toBeVisible();
  const draft = await input.inputValue();
  await input.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Use default directory", exact: true })).toBeFocused();
  await expect(input).toHaveValue(draft);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const style of ["original", "trae"]) {
  test(`${style}: mobile folder actions and file dialog escape sidebar clipping and restore focus`, async ({ page }) => {
    await open(page, 390, style);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const row = page.getByRole("treeitem", { name: "src", exact: true });
    const more = row.getByRole("button", { name: "More file actions: src", exact: true });
    await expect(more).toBeVisible();
    await more.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    expect(await menu.evaluate(el => el.parentElement === document.body)).toBe(true);
    await menu.getByRole("menuitem", { name: "New folder", exact: true }).click();
    const dialog = page.getByTestId("file-ops-dialog");
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(el => el.closest("[data-dialog-root]")?.parentElement === document.body)).toBe(true);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(more).toBeFocused();
    await more.press("Enter");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
  });

  test(`${style}: mobile session actions are body-portalled and system panel dismisses outside and with Escape`, async ({ page }) => {
    // Supply this panel's idle runtime snapshot explicitly. Other tests must
    // not have to start an agent before System becomes available.
    const sid = "aaaa1111-2222-3333-4444-555566667777";
    const systemPrompt = "UI audit fixture prompt";
    await page.route(url => url.pathname === `/api/sessions/${sid}`, async route => {
      const response = await route.fetch();
      const data = await response.json();
      data.agentState = { running: true, state: { isStreaming: false, systemPrompt } };
      await route.fulfill({ response, json: data });
    });
    await page.route(url => url.pathname === `/api/agent/${sid}/context-report`, route => route.fulfill({ json: {
      sessionId: sid, cwd: process.env.E2E_PROJECT_CWD, projectTrusted: false,
      contextUsage: null, effectiveSystemPrompt: systemPrompt,
      sources: [], skills: [], prompts: [], tools: [], diagnostics: [],
    } }));
    await open(page, 390, style);
    const trigger = page.getByRole("button", { name: "Session actions", exact: true });
    await trigger.click();
    const menu = page.locator('[class*="chatActionsMobileOpen"]');
    await expect(menu).toBeVisible();
    expect(await menu.evaluate(el => el.parentElement === document.body)).toBe(true);
    await expect(menu.getByRole("button", { name: "Branches", exact: true })).toBeVisible();
    await menu.getByRole("button", { name: "System", exact: true }).click();
    const panel = page.getByTestId("system-prompt-panel");
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await menu.getByRole("button", { name: "System", exact: true }).click();
    await expect(panel).toBeVisible();
    await page.getByRole("textbox", { name: "Message…", exact: true }).click();
    await expect(panel).toBeHidden();
  });
}

test("model health has Done; custom draft removal confirms and is not persisted until Save", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/models-config", route => {
    if (route.request().method() !== "GET") writes++;
    return route.fulfill({ headers: { etag: '"fixture-revision"' }, json: { providers: { "audit-provider": { api: "openai-completions", models: [{ id: "audit-model" }] } } } });
  });
  await open(page);
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Models", exact: true }).click();
  const dialog = page.getByTestId("models-config-dialog");
  await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "audit-provider", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  page.once("dialog", prompt => prompt.dismiss());
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "audit-provider", exact: true })).toBeVisible();
  page.once("dialog", prompt => prompt.accept());
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog.getByText("Unsaved custom model settings", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(writes).toBe(0);
  page.once("dialog", prompt => prompt.dismiss());
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeVisible();
  page.once("dialog", prompt => prompt.accept());
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(writes).toBe(0);
});

for (const width of [390, 1440]) {
  test(`${width}: a real branch menu supports selection, outside dismissal and focus return`, async ({ page }) => {
    const sid = "aaaa1111-2222-3333-4444-555566667777";
    let context: unknown;
    const navigation: string[] = [];
    const node = (id: string, text: string, children: unknown[] = []) => ({ entry: { type: "message", id, parentId: id === "root" ? null : "root", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: text, timestamp: 1 } }, children });
    await page.route(url => url.pathname === `/api/sessions/${sid}`, async route => {
      const response = await route.fetch(); const data = await response.json(); context = data.context;
      data.tree = [node("root", "root", [node("branch-left", "Left branch"), node("branch-right", "Right branch")])];
      data.leafId = "branch-left"; await route.fulfill({ response, json: data });
    });
    await page.route(url => url.pathname === `/api/sessions/${sid}/context`, route => route.fulfill({ json: { context } }));
    await page.route(url => url.pathname === `/api/agent/${sid}`, async route => {
      const body = route.request().method() === "POST" ? route.request().postDataJSON() : null;
      if (body?.type === "navigate_tree") { navigation.push(body.targetId); return route.fulfill({ json: { success: true } }); }
      return route.continue();
    });
    await open(page, width);
    const trigger = page.getByRole("button", { name: "Session actions", exact: true });
    await trigger.click();
    await page.getByRole(width <= 700 ? "button" : "menuitem", { name: /^Branches/ }).click();
    const panel = page.getByRole("dialog", { name: "Branches", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "user: Right branch", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect.poll(() => navigation).toEqual(["branch-right"]);
    await trigger.click();
    await page.getByRole(width <= 700 ? "button" : "menuitem", { name: /^Branches/ }).click();
    await expect(panel).toBeVisible();
    await page.getByRole("textbox", { name: "Message…", exact: true }).click();
    await expect(panel).toBeHidden();
  });
}
