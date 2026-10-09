import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";

const SESSION = "abcd7800-1111-2222-3333-444455556666";

test.beforeAll(() => {
  const root = process.env.E2E_ROOT;
  if (!root || process.env.PI_E2E_FIXTURES_READY !== root) throw new Error("Requires generated, isolated fixtures");
  const cwd = process.env.E2E_PROJECT_CWD!;
  const entries: unknown[] = [{ type: "session", version: 3, id: SESSION, timestamp: "2026-07-08T10:00:00.000Z", cwd }];
  let parentId: string | null = null;
  let sequence = 0;
  function append(message: Record<string, unknown>) {
    const id = (++sequence).toString(16).padStart(8, "0");
    const timestamp = new Date(Date.UTC(2026, 6, 8, 10) + sequence * 1000);
    entries.push({ type: "message", id, parentId, timestamp: timestamp.toISOString(), message: { ...message, timestamp: timestamp.getTime() } });
    parentId = id;
  }
  for (let turn = 0; turn < 26; turn++) {
    append({ role: "user", content: `Inspect synthetic turn ${turn}.` });
    for (let step = 0; step < 14; step++) {
      const id = `read-${turn}-${step}`;
      append({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "README.md" } }], stopReason: "toolUse", provider: "fixture", model: "fixture" });
      append({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "Synthetic historical output. No tool is executed.\n".repeat(32) }] });
    }
    append({ role: "assistant", stopReason: "stop", provider: "fixture", model: "fixture", content: [{ type: "text", text: Array.from({ length: 14 }, (_, i) => `### Section ${i}\n\nHistory marker ${turn}-${i}. ` + "A synthetic paragraph for layout verification. ".repeat(10)).join("\n\n") }] });
  }
  writeFileSync(path.join(root, "agent", "sessions", "-demo", `2026-07-08T10-00-00_${SESSION}.jsonl`), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
});

for (const width of [1440, 390]) {
  test(`780-message history survives reload, scroll, expand and find at ${width}px`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("crash", () => errors.push("renderer crashed"));
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
    await page.goto(`/?session=${SESSION}`);
    const composer = page.getByTestId("composer-shell").locator("textarea");
    const transcript = page.locator("[data-transcript-scroll]");
    await expect(composer).toBeVisible();
    await expect(page.locator(".msg-item")).toHaveCount(52);
    expect(await page.locator(".msg-item").evaluateAll(rows => rows.every(row => getComputedStyle(row).contentVisibility === "visible"))).toBe(true);
    for (const ratio of [0, 1, 0.5, 0, 1]) {
      await transcript.evaluate((element, ratio) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * ratio; }, ratio);
      await page.waitForTimeout(100);
    }
    const expand = page.getByRole("button", { name: /Show full message/ }).first();
    await expand.scrollIntoViewIfNeeded(); await expand.click();
    const collapse = page.getByRole("button", { name: /Collapse message/ }).first();
    await expect(collapse).toBeAttached(); await collapse.scrollIntoViewIfNeeded(); await collapse.click();
    const log = page.getByRole("button", { name: /Work log.*14 tools/ }).first();
    await log.scrollIntoViewIfNeeded(); await log.click(); await expect(log).toHaveAttribute("aria-expanded", "true");
    await transcript.evaluate(element => { element.scrollTop += 300; });
    await log.scrollIntoViewIfNeeded(); await log.click(); await expect(log).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Control+f");
    await page.getByPlaceholder("Find in conversation…").fill("History marker 0-13");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: /Collapse message/ }).first()).toBeAttached();
    await page.keyboard.press("Escape");
    await composer.fill("Long history remains interactive");
    await expect(composer).toHaveValue("Long history remains interactive");
    await page.reload(); await expect(composer).toBeVisible();
    await expect(composer).toHaveValue("Long history remains interactive");
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("long-transcript.png") });
  });
}
