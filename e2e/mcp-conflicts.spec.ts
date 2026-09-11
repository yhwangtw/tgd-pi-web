import { test, expect, type Page } from "@playwright/test";

async function openEditor(page: Page, id: string, width: number, origin = "") {
  await page.goto(`${origin}/?session=aaaa1111-2222-3333-4444-555566667777`);
  await expect(page.getByText("專案架構分析").first()).toBeVisible();
  if (width === 320) await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  const center = page.getByTestId("extensions-config");
  await center.getByRole("tab", { name: "MCP", exact: true }).click();
  await center.locator("article").filter({ has: page.getByText(id, { exact: true }) }).getByRole("button", { name: "Edit", exact: true }).click();
  return page.getByRole("dialog", { name: "Edit MCP server", exact: true });
}

for (const style of ["original", "trae"]) for (const width of [320, 1280]) {
  test(`${style} ${width}: two editors preserve drafts, reject stale changes and reload explicitly`, async ({ page, context, baseURL }) => {
    const id = `conflict-${style}-${width}`;
    const headers = { origin: baseURL!, "sec-fetch-site": "same-origin" };
    const created = await page.request.post("/api/mcp", { headers, data: { action: "save", server: {
      id, name: id, enabled: false, scope: "global", transport: "http", url: "https://example.test/mcp",
    } } });
    expect(created.status()).toBe(200);
    const initial = (await created.json()).server;
    await context.addInitScript(({ style, width }) => {
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-font-size", width === 320 ? "xlarge" : "default");
      localStorage.setItem("pi-theme", width === 320 ? "dark" : "light");
    }, { style, width });
    await page.setViewportSize({ width, height: 900 });
    const other = await context.newPage();
    await other.setViewportSize({ width, height: 900 });
    // Exercise both real host spellings. Next may expose an internal localhost
    // Request.url even when the browser sent Host/Origin 127.0.0.1.
    const browserOrigin = width === 320 ? baseURL!.replace("localhost", "127.0.0.1") : baseURL!;
    const editor = await openEditor(page, id, width, browserOrigin);
    const second = await openEditor(other, id, width, browserOrigin);
    await expect.poll(() => page.locator("html").getAttribute("data-ui-style").then(value => value ?? "original")).toBe(style);
    expect(await page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--font-scale")))).toBe(width === 320 ? 1.3 : 1);
    const name = editor.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("My unsaved draft");
    await second.getByRole("textbox", { name: "Name", exact: true }).fill("Saved in second tab");
    await second.getByRole("button", { name: "Save server" }).click();
    await expect(second).toBeHidden();
    const conflict = page.waitForResponse(response => response.url().endsWith("/api/mcp") && response.request().method() === "POST");
    await editor.getByRole("button", { name: "Save server" }).click();
    expect((await conflict).status()).toBe(409);
    const warning = editor.getByRole("alert");
    await warning.scrollIntoViewIfNeeded();
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("your draft was not saved");
    await expect(name).toHaveValue("My unsaved draft");
    await expect(editor.getByRole("button", { name: "Save server" })).toBeEnabled();
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const reload = editor.getByRole("button", { name: "Discard draft and reload" });
    await expect(reload).toBeVisible();
    if (width === 320) {
      const box = (await reload.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: test.info().outputPath(`mcp-conflict-${style}-${width}.png`) });
    const listed = (await (await page.request.get("/api/mcp")).json()).servers.find((server: { id: string }) => server.id === id);
    expect(listed.name).toBe("Saved in second tab");
    for (const action of ["toggle", "delete"]) {
      expect((await page.request.post("/api/mcp", { headers, data: { action, id, revision: initial.revision, enabled: false } })).status()).toBe(409);
    }
    await reload.focus(); await page.keyboard.press("Enter");
    await expect(name).toHaveValue("Saved in second tab");
    await expect(name).toBeFocused();
    await expect(warning).toBeHidden();
    await name.fill("Reviewed latest then edited");
    await editor.getByRole("button", { name: "Save server" }).click();
    await expect(editor).toBeHidden();
    const current = (await (await page.request.get("/api/mcp")).json()).servers.find((server: { id: string }) => server.id === id);
    expect(current.name).toBe("Reviewed latest then edited");
    expect(current.revision).not.toBe(listed.revision);
    await other.close();
  });
}

test("deleted configurations cannot be resurrected by an open editor", async ({ page, baseURL }) => {
  const headers = { origin: baseURL!, "sec-fetch-site": "same-origin" };
  const response = await page.request.post("/api/mcp", { headers, data: { action: "save", server: {
    id: "deleted-draft", name: "deleted-draft", enabled: false, transport: "http", url: "https://example.test/mcp",
  } } });
  expect(response.status()).toBe(200);
  const saved = (await response.json()).server;
  await page.setViewportSize({ width: 1280, height: 900 });
  const editor = await openEditor(page, saved.id, 1280);
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Keep for reference");
  expect((await page.request.post("/api/mcp", { headers, data: { action: "delete", id: saved.id, revision: saved.revision } })).status()).toBe(200);
  await editor.getByRole("button", { name: "Save server" }).click();
  await expect(editor.getByRole("alert")).toContainText("removed");
  await editor.getByRole("button", { name: "Discard draft and reload" }).click();
  await expect(editor.getByRole("alert")).toContainText("deleted");
  await expect(editor.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Keep for reference");
  expect((await (await page.request.get("/api/mcp")).json()).servers.some((server: { id: string }) => server.id === saved.id)).toBe(false);
});
