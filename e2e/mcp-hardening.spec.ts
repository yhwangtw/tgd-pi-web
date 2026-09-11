import { test, expect } from "@playwright/test";

for (const style of ["original", "trae"]) {
  for (const width of [320, 1280]) {
    test(`${style} ${width}: timeout units, validation, saved state and connection feedback`, async ({ page, baseURL }) => {
      const id = `mcp-ui-${style}-${width}`;
      const saved = await page.request.post("/api/mcp", {
        headers: { origin: baseURL!, "sec-fetch-site": "same-origin" },
        data: { action: "save", server: { id, name: id, enabled: false, transport: "http", scope: "global", url: "https://example.test/mcp", timeoutMs: 1250 } },
      });
      expect(saved.status()).toBe(200);
      await page.addInitScript(({ style, size }) => {
        localStorage.setItem("pi-ui-style", style);
        localStorage.setItem("pi-font-size", size);
      }, { style, size: width === 320 ? "xlarge" : "default" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/?session=aaaa1111-2222-3333-4444-555566667777");
      await expect(page.getByText("專案架構分析").first()).toBeVisible();
      // Original geometry / Default size intentionally remove their attributes.
      await expect.poll(() => page.locator("html").getAttribute("data-ui-style").then((value) => value ?? "original")).toBe(style);
      await expect.poll(() => page.locator("html").getAttribute("data-font-size").then((value) => value ?? "default")).toBe(width === 320 ? "xlarge" : "default");
      expect(await page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--font-scale")))).toBe(width === 320 ? 1.3 : 1);
      if (width === 320) await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("button", { name: "Extensions", exact: true }).click();
      const center = page.getByTestId("extensions-config");
      await center.getByRole("tab", { name: "MCP", exact: true }).click();
      const card = center.locator("article").filter({ has: page.getByText(id, { exact: true }) });
      await expect(card.getByText("Disabled", { exact: true })).toBeVisible();
      await card.getByRole("button", { name: "Edit", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "Edit MCP server", exact: true });
      const timeout = editor.getByRole("spinbutton", { name: "Timeout (seconds)" });
      const transport = editor.getByRole("combobox", { name: "Transport", exact: true });
      const assertFormGeometry = async () => {
        const timeoutBox = (await timeout.boundingBox())!;
        const transportBox = (await transport.boundingBox())!;
        expect(Math.abs(timeoutBox.height - transportBox.height)).toBeLessThanOrEqual(1);
        if (width === 1280) {
          expect(Math.abs(timeoutBox.y - transportBox.y)).toBeLessThanOrEqual(1);
        } else {
          for (const control of [timeout, transport, editor.getByRole("button", { name: "Save server" }), editor.getByRole("button", { name: "Cancel", exact: true })]) {
            const box = (await control.boundingBox())!;
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(box.width).toBeGreaterThanOrEqual(44);
          }
          expect(await editor.getByRole("checkbox").evaluate((element) => element.closest("label")!.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        }
      };
      await expect(timeout).toHaveValue("1.25");
      await assertFormGeometry();
      expect(await editor.getByRole("combobox", { name: "Transport", exact: true }).evaluate((element) => {
        const select = element as HTMLSelectElement;
        const styles = getComputedStyle(select);
        const context = document.createElement("canvas").getContext("2d")!;
        context.font = styles.font;
        return context.measureText(select.selectedOptions[0].text).width <= select.clientWidth
          - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) - 24;
      })).toBe(true);
      await timeout.fill("0.9999");
      await editor.getByRole("button", { name: "Save server" }).click();
      await expect(timeout).toBeFocused();
      await expect(timeout).toHaveAttribute("aria-invalid", "true");
      await expect(editor.getByText(/Enter a timeout between 1 and 120/)).toBeVisible();
      await assertFormGeometry();
      expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`mcp-timeout-${style}-${width}.png`) });
      await timeout.fill("2.5");
      await editor.getByRole("button", { name: "Save server" }).click();
      await expect(editor).toBeHidden();
      // The modal marks background regions aria-hidden, including the visible
      // toast. Include hidden AX nodes so this assertion cannot vacuously pass.
      const notifications = page.getByRole("region", { name: "Notifications", includeHidden: true });
      await expect(notifications).toBeVisible();
      const after = await page.request.get("/api/mcp");
      const configuration = (await after.json()).servers.find((server: { id: string }) => server.id === id);
      expect(configuration.timeoutMs).toBe(2500);
      expect(configuration.enabled).toBe(false);
      await card.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(timeout).toHaveValue("2.5");
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();

      // Transport behavior has real stdio/HTTP tests. This fixture explicitly
      // exercises the UI-only state that arrives after a catalog notification.
      await page.route("**/api/mcp*", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.servers = body.servers.map((server: { id: string }) => server.id === id ? { ...server, enabled: true } : server);
        body.statuses = body.statuses.map((status: { id: string }) => status.id === id ? {
          id, state: "connected", toolCount: 2, tools: [{ name: "first" }, { name: "second" }],
          catalogChanged: true, checkedAt: "2026-09-06T00:00:00.000Z",
        } : status);
        await route.fulfill({ response, json: body });
      });
      await center.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(card.getByText("Connected", { exact: true })).toBeVisible();
      await expect(card.locator("time")).toHaveAttribute("datetime", "2026-09-06T00:00:00.000Z");
      const notice = card.getByText(/The tool list changed/);
      await expect(notice).toBeVisible();
      expect(await notice.evaluate((element) => getComputedStyle(element).color)).toBe(await card.evaluate((element) => {
        const probe = document.createElement("span"); probe.style.color = "var(--text-muted)";
        element.appendChild(probe); const color = getComputedStyle(probe).color; probe.remove(); return color;
      }));
      expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const switchBox = (await card.getByRole("switch").boundingBox())!;
      expect(switchBox.width).toBeGreaterThanOrEqual(44);
      expect(switchBox.height).toBeGreaterThanOrEqual(44);
      await card.scrollIntoViewIfNeeded();
      await expect(notice).toBeInViewport();
      await expect(notifications).toBeHidden({ timeout: 10000 });
      await page.screenshot({ path: test.info().outputPath(`mcp-status-${style}-${width}.png`) });
    });
  }
}
