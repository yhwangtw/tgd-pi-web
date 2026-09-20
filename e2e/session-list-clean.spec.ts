import { expect, test, type Page } from "@playwright/test";
import type { SessionInfo } from "../lib/types";

const SID = "aaaa1111-2222-3333-4444-555566667777";
const SECOND = "bbbb1111-2222-3333-4444-555566667777";
async function setup(page: Page, style: string, width: number, font: string) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ style, font }) => {
    localStorage.setItem("pi-ui-style", style); localStorage.setItem("pi-skin", "terminal");
    localStorage.setItem("pi-theme", "light"); localStorage.setItem("pi-font-size", font);
    localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-session-scope", "all");
  }, { style, font });
  const pins = new Set([SID, SECOND]);
  await page.route("**/api/sessions/pins", async route => {
    const req = route.request();
    if (req.method() !== "GET") {
      const { id } = req.postDataJSON();
      if (req.method() === "DELETE") pins.delete(id); else pins.add(id);
    }
    await route.fulfill({ json: { pinned: [...pins] } });
  });
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.sessions = data.sessions.map((session: SessionInfo) => session.id === SID
      ? { ...session, name: "解析專案目錄", lastMessage: "已整理專案架構，可以接著討論下一步。" }
      : session.id === SECOND ? { ...session, name: "解析專案目錄", lastMessage: "這是另一段對話，摘要仍然能幫你區分。" } : session);
    await route.fulfill({ json: data });
  });
  await page.goto(`/?session=${SID}`);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
  if (width < 701) await page.locator('nav[class*="mobileNav"]').getByRole("button", { name: "Sessions", exact: true }).click();
  const row = page.locator(`[data-session-row="${SID}"]`);
  await expect(row).toBeVisible();
  return row;
}

for (const style of ["original", "trae"]) for (const width of [1440, 390, 320]) for (const font of ["small", "default", "xlarge"]) {
  test(`${style} ${width}px ${font}: two-line conversations retain context without technical clutter`, async ({ page }) => {
    const row = await setup(page, style, width, font);
    const list = page.getByRole("listbox", { name: "Sessions" });
    await expect(row.locator('[class*="sessionTitle"]')).toHaveText("解析專案目錄");
    await expect(row.locator('[class*="sessionTitle"]')).toHaveAttribute("title", /demo-project/);
    await expect(row).not.toContainText("Not a Git repo");
    await expect(row).not.toContainText("main");
    await expect(row.getByRole("button")).toHaveCount(1);
    await expect(row.locator('[class*="workspaceMeta"]')).toHaveText("demo-project");
    if (font === "default") expect(await row.locator('[class*="workspaceMeta"]').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
    await expect(row.locator('[class*="previewRow"]')).toContainText("已整理專案架構");
    const measure = await row.evaluate(el => {
      const row = el.getBoundingClientRect();
      const title = el.querySelector('[class*="titleRow"]')!.getBoundingClientRect();
      const preview = el.querySelector('[class*="previewRow"]')!.getBoundingClientRect();
      return { lines: getComputedStyle(el.querySelector('[class*="grid"]')!).gridTemplateRows.split(" ").length,
        contained: title.right <= row.right && preview.bottom <= row.bottom + 1,
        overlaps: title.bottom > preview.top + 1 };
    });
    expect(measure).toEqual({ lines: 2, contained: true, overlaps: false });
    expect(await list.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
    if (font === "default" && width !== 320) await list.screenshot({ path: test.info().outputPath(`sessions-${style}-${width}.png`) });
    await page.getByRole("group", { name: "Conversation scope" }).getByRole("button", { name: "This project", exact: true }).click();
    await expect(row.locator('[class*="workspaceMeta"]')).toHaveCount(0);
    await expect(row.locator('[class*="previewRow"]')).toContainText("已整理專案架構");
    await row.getByRole("button", { name: "More actions" }).click();
    const menu = page.getByRole("menu", { name: "Session actions", exact: true });
    expect(await menu.evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/);
    await expect(menu.getByRole("menuitem", { name: "Unpin session", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    if (width < 701) expect((await menu.getByRole("menuitem", { name: "Rename", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    await expect(row.getByRole("button", { name: "More actions" })).toBeFocused();
  });
}

test("consolidated menu supports keyboard rename, pin and safe delete cancellation", async ({ page }) => {
  let mutations = 0;
  await page.route(`**/api/sessions/${SID}`, async route => {
    if (["PATCH", "DELETE"].includes(route.request().method())) mutations++;
    await route.continue();
  });
  const row = await setup(page, "trae", 1440, "default");
  const trigger = row.getByRole("button", { name: "More actions" });
  await trigger.focus(); await trigger.press("Enter");
  const pin = page.getByRole("menuitem", { name: "Unpin session", exact: true });
  await expect(pin).toBeFocused(); await pin.press("Enter");
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: "Pin session", exact: true })).toBeVisible();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
  const rename = page.getByRole("menuitem", { name: "Rename", exact: true });
  await expect(rename).toBeFocused(); await rename.press("Enter");
  await expect(row.getByRole("textbox")).toBeFocused();
  await row.getByRole("textbox").press("Escape");
  await expect(row.getByRole("textbox")).toHaveCount(0);
  await trigger.click(); await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(mutations).toBe(0);
});

test("long lists keep end-of-list actions inside the phone viewport", async ({ page }) => {
  await setup(page, "trae", 320, "xlarge");
  await page.route("**/api/sessions", async route => {
    const data = await (await route.fetch()).json();
    const base = data.sessions.find((s: SessionInfo) => s.id === SID);
    data.sessions.push(...Array.from({ length: 500 }, (_, i) => ({ ...base,
      id: `generated-${i}`, name: `Archived discussion ${i}`,
      modified: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
    })));
    await route.fulfill({ json: data });
  });
  await page.reload();
  const list = page.getByRole("listbox", { name: "Sessions" });
  if (!await list.isVisible()) await page.locator('nav[class*="mobileNav"]').getByRole("button", { name: "Sessions", exact: true }).click();
  await expect(page.locator('[data-total-session-rows]')).toHaveAttribute("data-total-session-rows", /50\d/);
  // The virtualizer settles its measured row size after hydration. Keep the
  // test at the tail while that estimate is replaced by real geometry.
  await expect.poll(() => list.evaluate(el => {
    el.scrollTop = el.scrollHeight;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  })).toBeLessThan(2);
  expect(await list.locator('[data-session-row]').count()).toBeLessThan(40);
  const last = list.locator('[data-session-row]').last();
  const button = last.getByRole("button", { name: "More actions" });
  await button.click();
  const menu = page.getByRole("menu", { name: "Session actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(900);
  await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await expect(last.getByRole("textbox")).toBeFocused();
  await last.getByRole("textbox").press("Escape");
});
