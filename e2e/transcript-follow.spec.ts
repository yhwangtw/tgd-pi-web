import { isFixtureReadReceipt } from "./read-receipt-fixture";
import { test as base, expect, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { withFixtureMessages } from "./session-response-fixture";

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
const model = { provider: "scroll-fixture", id: "offline" };
const answer = (text: string) => ({
  role: "assistant", provider: model.provider, model: model.id, timestamp: 1,
  content: [{ type: "text", text }], stopReason: "stop",
});
const longText = (tail: string) => Array.from({ length: 35 }, (_, index) => `Scroll fixture paragraph ${index}.`).join("\n\n") + `\n\n${tail}`;

type OutputFixture = {
  open: (mode?: "smart" | "always" | "preserve") => Promise<void>;
  send: (event: Record<string, unknown>) => void;
  finish: (text: string) => void;
  prepareSend: (collapsePrevious?: boolean) => Promise<void>;
};

// Drive the real EventSource and message reducer over loopback SSE. The fixture
// never starts an agent or contacts a provider; only browser output is under test.
const test = base.extend<{ output: OutputFixture }>({
  output: async ({ page, baseURL }, runFixture) => {
    if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Requires a local fixture server");
    await page.addInitScript(() => localStorage.setItem("pi-composer-hints", "off"));
    let running = true;
    let allowPrompt = false;
    let messages: Record<string, unknown>[] = [{ role: "user", content: "Scroll regression fixture", timestamp: 1 }];
    const streams = new Set<ServerResponse>();
    const send = (event: Record<string, unknown>) => {
      for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const finish = (text: string) => {
      const message = answer(text);
      messages = messages.at(-1)?.role === "user" ? [...messages, message] : [messages[0], message];
      running = false;
      send({ type: "message_end", message });
      send({ type: "agent_end", messages: [message] });
    };
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": new URL(baseURL).origin });
      response.write("retry: 60000\n\n");
      streams.add(response);
      response.on("close", () => streams.delete(response));
      send({ type: "connected", sessionId: SESSION });
      send({ type: "session_snapshot", sessionId: SESSION,
        state: { isStreaming: running, model, thinkingLevel: "off" },
        streamingMessage: running ? answer(longText("Initial stream tail")) : null, bashRun: null,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const streamURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    const forbidden: string[] = [];
    await page.route("**/api/**", async (route) => {
      const req = route.request();
      if (["GET", "HEAD"].includes(req.method())) return route.continue();
      const path = new URL(req.url()).pathname;
      if (path === `/api/agent/${SESSION}/summarize`) return route.fulfill({ json: { skipped: true } });
      if (path === "/api/worktrees") return route.fulfill({ json: { worktrees: [] } });
      if (path === `/api/agent/${SESSION}` && req.postDataJSON()?.type === "get_tools") return route.fulfill({ json: { success: true, data: [] } });
      if (allowPrompt && path === `/api/agent/${SESSION}`) {
        const body = req.postDataJSON();
        if (body?.type === "prompt" && typeof body.message === "string" && body.message.startsWith("Send scroll fixture")) {
          messages.push({ role: "user", content: body.message, timestamp: Date.now() });
          running = true;
          return route.fulfill({ json: { success: true } });
        }
      }
      if (isFixtureReadReceipt(req)) return route.continue();
      forbidden.push(`${req.method()} ${path}`);
      return route.fulfill({ status: 403, json: { error: "Output fixture forbids mutations" } });
    });
    await page.route(new RegExp(`/api/sessions/${SESSION}(?:\\?|$)`), async (route) => {
      const response = await route.fetch();
      const data = withFixtureMessages(await response.json(), messages, messages.map((_, i) => `scroll-${i}`));
      await route.fulfill({ response, json: { ...data,
        agentState: { running, state: { isStreaming: running, model } },
      } });
    });
    await page.route(new RegExp(`/api/agent/${SESSION}/events(?:\\?|$)`), route => route.continue({ url: streamURL }));
    try {
      await runFixture({
        open: async (mode = "smart") => {
          await page.addInitScript((value) => localStorage.setItem("pi-scroll-follow-mode", value), mode);
          await page.goto(`/?session=${SESSION}`);
          await expect(page.getByText("Initial stream tail", { exact: true })).toBeAttached();
          await expect.poll(() => streams.size).toBe(1);
          if (mode === "preserve") await page.getByRole("button", { name: "Jump to bottom" }).click();
          await expectTailVisible(page, "Initial stream tail");
        },
        send,
        finish,
        prepareSend: async (collapsePrevious = true) => {
          allowPrompt = true;
          const history = collapsePrevious ? longText("Previous reply before sending")
            : Array.from({ length: 16 }, (_, i) => `Preserved context paragraph ${i}.`).join("\n\n") + "\n\nPrevious reply before sending";
          finish(history);
          await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
          await page.getByText("Previous reply before sending", { exact: true }).evaluate(node => node.scrollIntoView({ block: "end", behavior: "instant" }));
          await expectTailVisible(page, "Previous reply before sending");
        },
      });
      expect(forbidden).toEqual([]);
    } finally {
      if (test.info().status !== test.info().expectedStatus) {
        const geometry = await page.evaluate(() => {
          const viewport = document.querySelector("[data-transcript-scroll]");
          if (!viewport) return null;
          const frame = viewport.getBoundingClientRect();
          return { scrollTop: viewport.scrollTop, viewportHeight: viewport.clientHeight,
            messages: [...viewport.querySelectorAll(".msg-item")].map(node => {
              const box = node.getBoundingClientRect();
              return { role: node.getAttribute("data-message-role"), top: box.top - frame.top, height: box.height };
            }),
          };
        }).catch(() => null);
        await test.info().attach("scroll-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
});

async function expectTailVisible(page: Page, text: string) {
  const tail = page.getByText(text, { exact: true });
  await expect(tail).toBeInViewport();
  await expect.poll(async () => {
    const bottom = await tail.evaluate(node => node.getBoundingClientRect().bottom);
    const viewport = await page.locator("[data-transcript-scroll]").evaluate(node => node.getBoundingClientRect().bottom);
    return bottom - viewport;
  }).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "Jump to bottom" })).toHaveCount(0);
}

test("smart follows a final-only chunk and remains at the tail after viewport resize", async ({ page, output }) => {
  await output.open();
  // No preceding message_update: this includes content still inside the 80ms throttle window.
  output.finish(longText("Initial stream tail") + "\n\n" + longText("Final committed tail"));
  await expectTailVisible(page, "Final committed tail");
  await page.setViewportSize({ width: 740, height: 540 });
  await expectTailVisible(page, "Final committed tail");
});

test("smart preserves an upward reader at completion and Latest returns to the tail", async ({ page, output }) => {
  await output.open();
  await page.locator("[data-transcript-scroll]").hover();
  await page.mouse.wheel(0, -500);
  await expect(page.getByRole("button", { name: "Jump to bottom" })).toBeVisible();
  const [latest, transcript] = await Promise.all([
    page.getByRole("button", { name: "Jump to bottom" }).boundingBox(),
    page.locator("[data-transcript-scroll]").boundingBox(),
  ]);
  expect(latest!.y, "Latest must not cover transcript actions").toBeGreaterThanOrEqual(transcript!.y + transcript!.height - 1);
  const before = await page.locator("[data-transcript-scroll]").evaluate(node => node.scrollTop);
  output.finish(longText("Initial stream tail") + "\n\n" + longText("Paused final tail"));
  await expect(page.getByText("Paused final tail", { exact: true })).toBeAttached();
  await expect(page.getByText("Paused final tail", { exact: true })).not.toBeInViewport();
  await expect.poll(() => page.locator("[data-transcript-scroll]").evaluate(node => node.scrollTop)).toBeLessThanOrEqual(before + 2);
  await page.getByRole("button", { name: "Jump to bottom" }).click();
  await expectTailVisible(page, "Paused final tail");
});

test("always follows terminal output without an assistant text stream", async ({ page, output }) => {
  await output.open("always");
  output.send({ type: "message_end", message: answer(longText("Initial stream tail")) });
  output.send({ type: "bash_start", command: "offline-output-fixture" });
  output.send({ type: "bash_chunk", chunk: Array.from({ length: 40 }, (_, i) => `Terminal line ${i}`).join("\n") });
  const terminal = page.locator("[data-transcript-scroll] pre").last();
  await expect(terminal).toContainText("Terminal line 39");
  await expect.poll(async () => {
    const bounds = await terminal.boundingBox();
    const viewport = await page.locator("[data-transcript-scroll]").boundingBox();
    return bounds!.y + bounds!.height - viewport!.y - viewport!.height;
  }).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "Jump to bottom" })).toHaveCount(0);
});

test("Latest responds to reduced motion changes while preserving its destination", async ({ page, output }) => {
  await output.open();
  output.finish(longText("Motion preference tail"));
  await expectTailVisible(page, "Motion preference tail");
  await page.evaluate(() => {
    const nativeScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function(options) {
      if (typeof options === "object") document.documentElement.dataset.lastScrollBehavior = options.behavior;
      nativeScroll.call(this, options);
    };
  });
  for (const reducedMotion of ["reduce", "no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion });
    await page.locator("[data-transcript-scroll]").evaluate(node => { node.scrollTop = 0; });
    await page.getByRole("button", { name: "Jump to bottom" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-last-scroll-behavior", reducedMotion === "reduce" ? "instant" : "smooth");
    await expectTailVisible(page, "Motion preference tail");
  }
});

test("preserve mode also applies to layout changes after a reply completes", async ({ page, output }) => {
  await output.open();
  output.finish(longText("Completed before preserving"));
  await expectTailVisible(page, "Completed before preserving");
  await page.getByRole("button", { name: "More composer controls" }).click();
  await page.getByRole("radio", { name: "Preserve position", exact: true }).click();
  const before = await page.locator("[data-transcript-scroll]").evaluate(node => node.scrollTop);
  await page.setViewportSize({ width: 1280, height: 420 });
  await expect(page.getByRole("button", { name: "Jump to bottom" })).toBeVisible();
  await expect(page.getByText("Completed before preserving", { exact: true })).not.toBeInViewport();
  await expect.poll(() => page.locator("[data-transcript-scroll]").evaluate(node => node.scrollTop)).toBeLessThanOrEqual(before + 2);
});

for (const style of ["original", "trae"] as const) {
  test(`${style}: mobile Latest responds to the first tap while typing without covering messages`, async ({ page, output }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.addInitScript(style => {
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-locale", "en");
    }, style);
    await output.open();
    const composer = page.getByTestId("composer-shell").locator("textarea");
    await composer.focus();
    await page.locator("[data-transcript-scroll]").hover();
    await page.mouse.wheel(0, -500);
    const latest = page.getByRole("button", { name: "Jump to bottom" });
    await expect(latest).toBeVisible();
    const [buttonBox, transcriptBox] = await Promise.all([latest.boundingBox(), page.locator("[data-transcript-scroll]").boundingBox()]);
    expect(buttonBox!.y).toBeGreaterThanOrEqual(transcriptBox!.y + transcriptBox!.height - 1);
    expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
    await latest.click();
    await expectTailVisible(page, "Initial stream tail");
    await expect(composer).toBeFocused();
  });
}


async function sentPromptBounds(page: Page) {
  return page.locator(".msg-item").filter({ hasText: "Send scroll fixture" }).last().evaluate(node => {
    const viewport = document.querySelector("[data-transcript-scroll]")!;
    const box = node.getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    return { top: box.top - frame.top, bottom: box.bottom - frame.top, height: box.height, viewportHeight: viewport.clientHeight };
  });
}

for (const [device, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 850]] as const) {
  test(`${device}: sending a short prompt leaves previous context above the upper-quarter anchor`, async ({ page, output }) => {
    await page.setViewportSize({ width, height });
    await output.open();
    await output.prepareSend();
    const input = page.getByTestId("composer-shell").locator("textarea");
    await input.fill("Send scroll fixture short prompt");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect.poll(async () => {
      const bounds = await sentPromptBounds(page);
      return Math.abs(bounds.top - bounds.viewportHeight / 4);
    }).toBeLessThanOrEqual(2);
    // A dock or viewport can shrink after the initial frame pass.
    await page.setViewportSize({ width, height: height - 28 });
    await expect.poll(async () => {
      const bounds = await sentPromptBounds(page);
      return Math.abs(bounds.top - bounds.viewportHeight / 4);
    }).toBeLessThanOrEqual(2);
    await expect(page.locator('.msg-item[data-message-role="assistant"]').first()).toBeInViewport();
    const before = await sentPromptBounds(page);
    await page.screenshot({ path: test.info().outputPath(`send-anchor-${device}.png`) });
    output.finish("A short completed reply.");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect.poll(async () => Math.abs((await sentPromptBounds(page)).top - before.top)).toBeLessThanOrEqual(2);
  });

  test(`${device}: preserve mode only scrolls enough to reveal a sent prompt`, async ({ page, output }) => {
    await page.setViewportSize({ width, height: Math.min(height, 800) });
    await output.open("preserve");
    await output.prepareSend(false);
    const input = page.getByTestId("composer-shell").locator("textarea");
    await input.fill("Send scroll fixture preserved prompt");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    // When Latest disappears the viewport grows. Preserve should not make a
    // second unnecessary move just to keep an exact bottom gap after reflow.
    await expect.poll(async () => {
      const bounds = await sentPromptBounds(page);
      return bounds.top >= 14 && bounds.bottom <= bounds.viewportHeight - 14;
    }).toBe(true);
    const bounds = await sentPromptBounds(page);
    // Preserve promises visibility and a stable reading point. Earlier rows
    // may reflow; it must not force a new quarter/top alignment afterward.
    output.finish(longText("Reply remains below the preserved position."));
    await expect(page.getByRole("button", { name: "Jump to bottom" })).toBeVisible();
    await expect.poll(async () => Math.abs((await sentPromptBounds(page)).top - bounds.top)).toBeLessThanOrEqual(2);
  });

  test(`${device}: a tall prompt reveals its beginning and new output can still follow`, async ({ page, output }) => {
    await page.setViewportSize({ width, height });
    await output.open();
    await output.prepareSend();
    const input = page.getByTestId("composer-shell").locator("textarea");
    await input.fill("Send scroll fixture long prompt\n\n" + Array.from({ length: 45 }, (_, i) => `Prompt paragraph ${i}.`).join("\n\n"));
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect.poll(async () => Math.abs((await sentPromptBounds(page)).top - 16)).toBeLessThanOrEqual(2);
    output.finish(longText("Reply after tall sent prompt"));
    await expectTailVisible(page, "Reply after tall sent prompt");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}
