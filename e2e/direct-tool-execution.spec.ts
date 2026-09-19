import { expect, test } from "@playwright/test";

test("embedded tools run without Web approval while browser file APIs remain protected", async ({ page, request }) => {
  const responses: unknown[] = [];
  page.on("request", request => {
    if (request.method() !== "POST" || !request.url().includes("/api/agent/")) return;
    const body = request.postDataJSON();
    if (body?.type === "extension_ui_response") responses.push(body);
  });
  await page.goto("/?session=aaaa1111-2222-3333-4444-555566667777");
  const composer = page.getByTestId("composer-shell").locator("textarea");
  await expect(composer).toBeVisible();
  await composer.fill("/e2e-reconnect-outside direct-read");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("assistant-message").filter({ hasText: "Direct tool completed direct-read." })).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId("inline-user-question")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(responses).toEqual([]);
  // This same outside-workspace file is not exposed by the browser file API.
  const outsidePath = `${process.env.E2E_ROOT}/outside-read.txt`;
  const response = await request.get(`/api/files/${encodeURIComponent(outsidePath)}?type=meta`);
  expect(response.status()).toBe(403);
});
