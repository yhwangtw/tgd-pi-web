import { expect, test } from "@playwright/test";

const MAIN = "aaaa1111-2222-3333-4444-555566667777";

for (const style of ["original", "trae"] as const) {
  for (const width of [1440, 390, 320]) {
    test(`${style} ${width}px: ask_user is non-modal, deferrable, and answers once`, async ({ page, context, baseURL }, testInfo) => {
      const token = `${style}-${width}`;
      const forbidden: string[] = [];
      const responses: Record<string, unknown>[] = [];
      const origin = new URL(baseURL!).origin;
      // Context-wide coverage includes any new tab. Only fixture commands can
      // mutate agent state; no file writes, paid prompts, or external requests.
      await context.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
        if (["GET", "HEAD"].includes(request.method())) return route.continue();
        let body: Record<string, any> = {};
        try { body = request.postDataJSON(); } catch { /* Reject invalid bodies below. */ }
        if (/\/summarize$/.test(url.pathname)) return route.fulfill({ json: { skipped: true } });
        if (url.pathname === "/api/worktrees" && Array.isArray(body.cwds) && Object.keys(body).length === 1) return route.continue();
        if (url.pathname === `/api/agent/${MAIN}`) {
          if (["get_tools", "get_state", "abort"].includes(body.type)) return route.continue();
          if (body.type === "prompt" && body.message === `/e2e-reconnect-question ${token}`) return route.continue();
          if (body.type === "extension_ui_response") { responses.push(body); return route.continue(); }
        }
        forbidden.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 403, json: { error: "Only offline question fixture actions are allowed" } });
      });
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(style => {
        localStorage.setItem("pi-locale", "en");
        localStorage.setItem("pi-ui-style", style);
        localStorage.setItem("pi-skin", style === "trae" ? "trae" : "default");
        localStorage.setItem("pi-font-size", "default");
      }, style);
      await page.goto(`/?session=${MAIN}`);
      await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
      // A closed mobile sidebar is intentionally inert. Opening a question
      // must not make any additional surface inert or disable the card itself.
      const inertBeforeQuestion = await page.locator("[inert]").count();
      await page.getByRole("textbox", { name: "Message…", exact: true }).fill(`/e2e-reconnect-question ${token}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const card = page.getByTestId("inline-user-question");
      await expect(card).toBeAttached({ timeout: 20_000 });
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator("[inert]")).toHaveCount(inertBeforeQuestion);
      expect(await card.evaluate(element => Boolean(element.closest("[inert]")))).toBe(false);
      expect(await card.evaluate(element => Boolean(element.closest("[data-transcript-scroll]")))).toBe(true);
      await page.getByRole("button", { name: "View question", exact: true }).click();
      await expect(card.getByRole("heading", { name: "Decision needed" })).toBeInViewport();
      await card.getByRole("radio", { name: "Staging", exact: false }).click();
      await card.getByRole("button", { name: "Next", exact: true }).click();
      const answer = card.getByRole("textbox", { name: "What should we check first?" });
      await answer.fill("Keep this answer while I inspect the conversation.");
      await card.getByRole("button", { name: "Answer later", exact: true }).click();
      await expect(answer).toBeHidden();
      expect(responses).toHaveLength(0);
      const composer = page.getByRole("textbox", { name: "Queue a follow-up…", exact: true });
      await expect(composer).toBeVisible();
      await composer.fill("A separate unsent draft.");
      await expect(composer).toBeFocused();
      await page.keyboard.press("Escape");
      expect(responses).toHaveLength(0);
      const transcript = page.locator("[data-transcript-scroll]");
      await transcript.hover();
      await page.mouse.wheel(0, -1600);
      await page.getByRole("button", { name: "View question", exact: true }).click();
      await expect(answer).toBeVisible();
      await expect(answer).toHaveValue("Keep this answer while I inspect the conversation.");
      await expect(composer).toHaveValue("A separate unsent draft.");
      const bounds = await card.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("ask-user-inline.png") });
      await card.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(card).toHaveCount(0);
      await expect(page.getByTestId("pending-question-notice")).toHaveCount(0);
      await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture answer received ${token}.` })).toHaveCount(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({ answers: { target: "Staging", note: "Keep this answer while I inspect the conversation." } });
      expect(forbidden).toEqual([]);
    });
  }
}
