import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GenerationSettingsState } from "../lib/generation-settings";
import { selectFileAction } from "./file-preview-actions";
const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

async function open(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-ui-style", "trae");
    localStorage.setItem("pi-skin", "trae"); localStorage.setItem("pi-theme", "dark");
  });
  await page.route("**/api/models**", route => route.fulfill({ json: {
    modelList: [{ provider: "anthropic", id: "claude-sonnet-5", name: "A deliberately long descriptive current model (anthropic)", available: true },
      { provider: "fixture", id: "alternate", name: "Alternate fixture model", available: true }], thinkingLevels: {}, thinkingLevelMaps: {},
  } }));
  const selections: Record<string, unknown>[] = [];
  let settings: GenerationSettingsState = {
    selected: null, active: null, revision: 0, pending: false, restarting: false, runId: null, canRestart: false,
  };
  await page.route("**/api/agent/*", route => {
    if (route.request().method() === "POST") {
      const command = route.request().postDataJSON();
      const model = command?.model;
      if (new URL(route.request().url()).pathname === "/api/agent/aaaa1111-2222-3333-4444-555566667777"
        && command?.type === "configure_generation" && Object.keys(command).length === 2
        && model && Object.keys(model).length === 2
        && (model.provider === "anthropic" && model.modelId === "claude-sonnet-5"
          || model.provider === "fixture" && model.modelId === "alternate")) {
        selections.push(command);
        settings = { ...settings, selected: { provider: model.provider, modelId: model.modelId, thinkingLevel: "off" },
          revision: settings.revision + 1 };
        return route.fulfill({ json: { success: true, data: settings } });
      }
      if (command?.type === "get_tools") return route.fulfill({ json: { success: true, data: [] } });
      return route.fulfill({ status: 403, json: { error: "Audit fixture forbids agent execution" } });
    }
    return route.fallback();
  });
  await page.route(/\/api\/sessions\/aaaa1111-2222-3333-4444-555566667777(?:\?includeState)?$/, async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: {
      ...data, context: { ...data.context,
        model: settings.selected ? { provider: settings.selected.provider, modelId: settings.selected.modelId } : data.context.model,
        thinkingLevel: settings.selected?.thinkingLevel ?? data.context.thinkingLevel }, agentState: { running: false },
    } });
  });
  await page.goto(MAIN);
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
  return selections;
}
async function nav(page: Page, label: string) {
  if (page.viewportSize()!.width <= 700 && !["Files", "Sessions", "Chat"].includes(label)) await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: label, exact: true }).click();
}

for (const width of [390, 883, 1280]) test(`${width}: composer stays on one action row; search, pins and controls preserve state`, async ({ page }, info) => {
  const selections = await open(page, width);
  const trigger = page.getByTestId("model-selector-trigger");
  await trigger.click();
  await page.getByRole("dialog", { name: "Choose a model", exact: true }).getByRole("button", { name: /A deliberately long descriptive current model/ }).click();
  await expect(trigger).toContainText("A deliberately long descriptive current model");
  expect((await trigger.locator("svg").first().boundingBox())!.width).toBeGreaterThanOrEqual(12);
  const controls = page.getByRole("button", { name: "More composer controls", exact: true });
  const [a, b] = await Promise.all([trigger.boundingBox(), controls.boundingBox()]);
  expect(Math.abs(a!.y + a!.height / 2 - b!.y - b!.height / 2)).toBeLessThan(5);
  await page.screenshot({ path: info.outputPath(`chat-${width}.png`) });
  await trigger.click();
  const picker = page.getByRole("dialog", { name: "Choose a model", exact: true });
  await expect(picker.getByRole("heading", { name: "Current model", exact: true })).toBeVisible();
  await picker.getByRole("searchbox", { name: "Search models" }).fill("Alternate");
  await expect(picker.locator("[data-model-choice]")).toHaveCount(1);
  await picker.getByRole("button", { name: "Pin model", exact: true }).click();
  await expect(picker.getByRole("button", { name: "Unpin model", exact: true })).toBeVisible();
  await picker.getByRole("searchbox", { name: "Search models" }).fill("not-a-model");
  await expect(picker.locator("[data-model-choice]")).toHaveCount(0);
  await picker.getByRole("searchbox", { name: "Search models" }).fill("");
  await expect.poll(async () => {
    const box = await picker.boundingBox();
    const viewport = page.viewportSize()!;
    return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
  }).toBe(true);
  await page.screenshot({ path: info.outputPath(`models-${width}.png`) });
  await page.keyboard.press("Escape");
  await controls.click();
  await page.getByRole("button", { name: "Expand composer", exact: true }).click();
  await page.getByRole("button", { name: "Collapse composer", exact: true }).first().click();
  await expect(controls).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("region", { name: "Composer controls", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(controls).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("region", { name: "Composer controls", exact: true })).toBeHidden();
  const selectionsBeforeAlternate = selections.length;
  await trigger.click();
  await page.getByRole("dialog", { name: "Choose a model", exact: true }).getByRole("button", { name: /Alternate fixture model/ }).click();
  await expect(trigger).toContainText("Alternate fixture model");
  expect(selections.slice(selectionsBeforeAlternate)).toEqual([{ type: "configure_generation", model: { provider: "fixture", modelId: "alternate" } }]);
});

test("sorting and appearance expose readable single choices", async ({ page }, info) => {
  await open(page);
  await page.getByRole("button", { name: /Sort:/ }).click();
  const sort = page.getByRole("menu", { name: "Sort" });
  await expect(sort.getByRole("menuitemradio")).toHaveCount(3);
  await sort.getByRole("menuitemradio", { name: "Name", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sort: Name", exact: true })).toContainText("Name");
  await expect(page.getByRole("button", { name: /Unread conversations/ })).toBeVisible();
  await nav(page, "Appearance");
  const appearance = page.getByRole("dialog", { name: "Appearance", exact: true });
  const fonts = appearance.getByRole("radiogroup", { name: "Font size", exact: true });
  await fonts.locator('[aria-checked="true"]').focus();
  await page.keyboard.press("ArrowRight");
  await expect(fonts.getByRole("radio", { name: "Large", exact: true })).toBeChecked();
  await page.screenshot({ path: info.outputPath("appearance.png") });
});

test("Markdown outline scrolls the preview without dismissing Inspector; links meet contrast", async ({ page }, info) => {
  const content = "# Audit reading fixture\n\n[External reference](https://example.com)\n\n" + "Paragraph for scrolling.\n\n".repeat(45) + "## Target heading\n\nFinal section.\n";
  writeFileSync(join(process.env.E2E_PROJECT_CWD!, "audit-reading.md"), content);
  await open(page, 883);
  await nav(page, "Explorer");
  await page.getByRole("treeitem", { name: "audit-reading.md", exact: true }).click();
  const panel = page.locator(".right-panel-open");
  const preview = panel.getByRole("button", { name: "Preview", exact: true });
  if (await preview.getAttribute("aria-pressed") !== "true") await preview.click();
  const link = panel.getByRole("link", { name: /^External reference/ });
  await expect(link).toBeVisible();
  const ratio = await link.evaluate(element => {
    const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(v => { const n = Number(v) / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((total, value, i) => total + value * [.2126, .7152, .0722][i], 0);
    let node: Element | null = element; let background = "";
    while (node) { background = getComputedStyle(node).backgroundColor; if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") break; node = node.parentElement; }
    const a = luminance(getComputedStyle(element).color), b = luminance(background);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  await selectFileAction(page, panel, "Inspector");
  await panel.getByRole("button", { name: /Target heading/ }).click();
  await expect(preview).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("tab", { name: "Outline", exact: true })).toBeVisible();
  const heading = panel.getByRole("heading", { name: "Target heading", exact: true });
  await expect(heading).toBeInViewport();
  await page.screenshot({ path: info.outputPath("outline-preview.png") });
});

test("skills empty search hides the old action and restores it on clear", async ({ page }, info) => {
  await open(page);
  await nav(page, "Skills");
  const dialog = page.getByTestId("skills-config-dialog");
  const detail = dialog.getByTestId("skills-config-detail");
  await expect(detail.getByRole("button", { name: "Disable skill", exact: true })).toBeVisible();
  const search = dialog.getByTestId("skills-config-nav").getByRole("textbox");
  await search.fill("impossible-match-7340");
  await expect(detail.getByText("No matching skills", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Disable skill", exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("skills-empty.png") });
  await search.fill("");
  await expect(detail.getByRole("button", { name: "Disable skill", exact: true })).toBeVisible();
});

test("Agents comparison stacks in a narrow pane and preserves long names and costs", async ({ page }, info) => {
  await page.route("**/api/agent-runs**", route => route.fulfill({ json: {
    runs: [1, 2].map(n => ({ id: `audit-${n}`, name: `A deliberately long completed run name ${n}`, status: "completed", trigger: "manual", cwd: "/fixture/project", prompt: "Read and report", sessionId: `fixture-${n}`, createdAt: "2026-10-17T10:00:00Z", toolNames: [], report: { summary: "Complete report summary", changedFiles: ["README.md"], tests: [], usage: { cost: 1234.567, input: 1, output: 1 } } })), maxConcurrency: 3, counts: {},
  } }));
  await open(page, 883);
  await nav(page, "Agents");
  const dashboard = page.getByTestId("agent-dashboard");
  const choices = dashboard.getByRole("checkbox", { name: /Select for comparison/ });
  await expect(choices).toHaveCount(2);
  for (const checkbox of await choices.all()) await checkbox.check();
  await dashboard.getByRole("button", { name: /^Compare/ }).click();
  const compare = dashboard.getByRole("region", { name: "Compare results", exact: true });
  await expect(compare.locator("article")).toHaveCount(2);
  const boxes = await compare.locator("article").evaluateAll(nodes => nodes.map(node => ({ y: node.getBoundingClientRect().y, bottom: node.getBoundingClientRect().bottom, overflow: node.scrollWidth > node.clientWidth + 1 })));
  expect(boxes[1].y).toBeGreaterThanOrEqual(boxes[0].bottom);
  expect(boxes.every(b => !b.overflow)).toBe(true);
  const sidebar = page.locator(".sidebar-container");
  expect(await sidebar.evaluate(element => element.scrollLeft)).toBe(0);
  expect(await dashboard.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(compare.getByText("$1234.567", { exact: true })).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("agents-compare.png") });
});
