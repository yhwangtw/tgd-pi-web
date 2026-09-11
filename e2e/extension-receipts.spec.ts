import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const MAIN_ID = "aaaa1111-2222-3333-4444-555566667777";
const ENDPOINT = `/api/agent/${MAIN_ID}`;

function decisions(requestId: string) {
  const root = process.env.E2E_ROOT;
  if (!root) throw new Error("Generated E2E fixture root is required");
  const source = path.join(root, "agent/sessions/-demo/2026-07-01T10-00-00_aaaa1111-2222-3333-4444-555566667777.jsonl");
  return readFileSync(source, "utf8").trim().split("\n").map(line => JSON.parse(line))
    .filter(entry => entry.type === "custom" && entry.customType === "web_ui_decision" && entry.data?.request?.id === requestId);
}

test("two tabs acknowledge a committed answer after a lost HTTP reply without another decision", async ({ page }) => {
  // /e2e-ui is a generated local extension; it opens dialogs, never calls an LLM.
  let observed!: (value: Record<string, unknown>) => void;
  const committed = new Promise<Record<string, unknown>>(resolve => { observed = resolve; });
  let dropped = false;
  await page.route(`**${ENDPOINT}`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    if (body.type === "prompt" && body.message !== "/e2e-ui") throw new Error("Only the local dialog fixture may be prompted");
    if (body.type !== "extension_ui_response" || dropped) return route.continue();
    dropped = true;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({ success: true, data: { accepted: true } });
    observed(body);
    await route.abort("failed"); // Commit succeeded; only its browser HTTP ACK is lost.
  });

  await page.goto(`/?session=${MAIN_ID}`);
  const composer = page.getByRole("textbox", { name: "Message…", exact: true });
  await expect(composer).toBeVisible();
  await composer.fill("/e2e-ui");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose a release target" })).toBeVisible();
  const otherTab = await page.context().newPage();
  try {
    await otherTab.goto(`/?session=${MAIN_ID}`);
    await expect(otherTab.getByRole("heading", { name: "Choose a release target" })).toBeVisible();
    await page.getByRole("radio", { name: "Production", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const response = await committed;
    const requestId = response.id as string;

    // Both tabs retry the exact observed response over the real HTTP handler.
    const receipts = await Promise.all([page, otherTab].map(async tab => {
      const reply = await tab.request.post(ENDPOINT, { data: response });
      expect(reply.ok()).toBe(true);
      return reply.json();
    }));
    for (const receipt of receipts) expect(receipt).toEqual({ success: true, data: { accepted: true, receipt: "already_answered" } });
    const conflicting = await otherTab.request.post(ENDPOINT, { data: { ...response, value: "Staging" } });
    expect(await conflicting.json()).toEqual({ success: true, data: { accepted: false, reason: "response_conflict" } });
    await expect.poll(() => decisions(requestId).length).toBe(1);
    expect(decisions(requestId)[0].data).toMatchObject({ outcome: "answered", response: { value: "Production" } });

    // The command was resumed once and both native EventSources reached its
    // next dialog instead of leaving a stale question or duplicate decision.
    for (const tab of [page, otherTab]) {
      await expect(tab.getByRole("heading", { name: "Confirm release" })).toBeVisible();
      await expect(tab.getByRole("heading", { name: "Choose a release target" })).toBeHidden();
    }
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Confirm release" })).toBeHidden();
    await expect(otherTab.getByRole("heading", { name: "Confirm release" })).toBeHidden();
    expect(decisions(requestId)).toHaveLength(1);
  } finally {
    await otherTab.close();
  }
});
