import { expect, type Locator, type Page } from "@playwright/test";

/** File menus are portalled outside the viewer that owns their trigger. */
export async function openFileActions(page: Page, viewer: Locator) {
  await viewer.getByRole("button", { name: "More file actions", exact: true }).click();
  const menu = page.getByRole("menu", { name: "More file actions", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

export async function selectFileAction(page: Page, viewer: Locator, label: string) {
  const menu = await openFileActions(page, viewer);
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
  await expect(menu).toBeHidden();
}

async function openPanelLayout(page: Page, panel: Locator) {
  const trigger = panel.getByRole("button", { name: "Panel layout", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Panel layout", exact: true });
  await expect(menu).toBeVisible();
  return { trigger, menu };
}

export async function selectPanelLayoutAction(page: Page, panel: Locator, label: string) {
  const primary = panel.getByRole("button", { name: label, exact: true });
  if (await primary.isVisible()) {
    await primary.click();
    return;
  }
  const { menu } = await openPanelLayout(page, panel);
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
  await expect(menu).toBeHidden();
}

/** Narrow panels expose their expansion state through the layout menu. */
export async function expectPanelExpanded(page: Page, panel: Locator, expanded: boolean) {
  const label = expanded ? "Restore file panel" : "Expand file panel";
  const primary = panel.getByRole("button", { name: label, exact: true });
  if (await primary.isVisible()) {
    await expect(primary).toHaveAttribute("aria-pressed", String(expanded));
    return;
  }
  const { trigger, menu } = await openPanelLayout(page, panel);
  await expect(menu.getByRole("menuitem", { name: label, exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: expanded ? "Expand file panel" : "Restore file panel", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
}
