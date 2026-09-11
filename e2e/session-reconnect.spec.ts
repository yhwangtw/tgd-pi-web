import { expect, test as base, type Page } from "@playwright/test";
import { createServer, request as httpRequest, type ClientRequest, type ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import type { Socket } from "node:net";

const MAIN_ID = "aaaa1111-2222-3333-4444-555566667777";
const PROVIDER = "e2e-reconnect-fixture";
const STREAM_PATH = /^\/api\/agent\/([^/]+)\/events$/;
type Frame = { path: string; id: string; event: Record<string, any> };
type WireRequest = { path: string; method: string; body?: Record<string, any>; framesBefore: number };
type Probe = { online: number; offline: number; visibility: string[] };

function loopback(url: URL) { return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname); }

/** A real HTTP relay, not an EventSource replacement or fabricated SSE feed.
 * Only the selected loopback fixture server is reachable. Closing its sockets
 * exercises Chromium's native transport errors and the application's cursor
 * reconnect. All listeners/sockets are released even when an assertion fails.
 */
async function reconnectRelay(baseURL: string) {
  const target = new URL(baseURL);
  if (target.protocol !== "http:" || !loopback(target)) throw new Error("Reconnect tests require a loopback HTTP fixture");
  let blockStreams = false;
  let dropForkReply = false;
  let droppedFork: Record<string, any> | null = null;
  const frames: Frame[] = [];
  const requests: WireRequest[] = [];
  const forbidden: string[] = [];
  const streams = new Set<{ upstream: ClientRequest; downstream: ServerResponse }>();
  const sockets = new Set<Socket>();
  const cutStreams = () => {
    blockStreams = true;
    for (const stream of streams) { stream.downstream.destroy(); stream.upstream.destroy(); }
    streams.clear();
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) { outgoing.writeHead(400).end(); return; }
      const url = new URL(incoming.url, target);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 64 * 1024) { outgoing.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      let body: Record<string, any> | undefined;
      try { body = JSON.parse(bytes.toString()); } catch { /* GET/static requests have no JSON body. */ }
      requests.push({ path: url.pathname + url.search, method: incoming.method ?? "GET", body, framesBefore: frames.length });
      // Automatic naming would otherwise be allowed to contact a provider.
      if (/\/api\/agent\/[^/]+\/summarize$/.test(url.pathname)) {
        outgoing.writeHead(200, { "Content-Type": "application/json" }).end('{"skipped":true,"reason":"offline-fixture"}'); return;
      }
      if (incoming.method === "POST" && /^\/api\/agent\/(?:new|[^/]+)$/.test(url.pathname)) {
        const fixturePrompt = typeof body?.message === "string" && /^\/e2e-reconnect-(complete|delayed|error) [a-z0-9-]{1,80}$/.test(body.message);
        const safe = (body?.type === "prompt" && fixturePrompt && (url.pathname !== "/api/agent/new" || (body.deferPrompt === true && body.provider === PROVIDER && body.modelId === "deterministic")))
          || ["get_tools", "get_state", "set_tools", "set_thinking_level", "set_auto_compaction", "abort", "fork"].includes(body?.type)
          || (body?.type === "set_model" && body.provider === PROVIDER && body.modelId === "deterministic");
        if (!safe) {
          forbidden.push(`${incoming.method} ${url.pathname} ${body?.type}`);
          outgoing.writeHead(403).end("Only offline reconnect fixture commands are allowed"); return;
        }
      }
      const stream = STREAM_PATH.test(url.pathname);
      if (stream && blockStreams) { outgoing.writeHead(503).end("Deterministic SSE outage"); return; }
      const loseThisReply = dropForkReply && body?.type === "fork";
      if (loseThisReply) { dropForkReply = false; cutStreams(); }
      const upstream = httpRequest(url, {
        method: incoming.method,
        headers: { ...incoming.headers, "accept-encoding": stream ? "identity" : incoming.headers["accept-encoding"] ?? "identity" },
      }, (response) => {
        if (loseThisReply) {
          const reply: Buffer[] = [];
          response.on("data", chunk => reply.push(Buffer.from(chunk)));
          response.on("end", () => {
            try { droppedFork = JSON.parse(Buffer.concat(reply).toString()); }
            catch { droppedFork = { error: "Non-JSON fork response" }; }
            outgoing.destroy(); // The server committed; neither POST ACK nor SSE reached the browser.
          });
          return;
        }
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        if (stream) {
          const decoder = new StringDecoder("utf8");
          let pending = "";
          response.on("data", chunk => {
            pending += decoder.write(chunk);
            let boundary: number;
            while ((boundary = pending.indexOf("\n\n")) !== -1) {
              const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
              const data = raw.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
              if (!data) continue;
              try { frames.push({ path: url.pathname + url.search, id: raw.split("\n").find(line => line.startsWith("id:"))?.slice(3).trim() ?? "", event: JSON.parse(data) }); }
              catch { /* The browser must handle a malformed upstream frame itself. */ }
            }
          });
        }
        response.pipe(outgoing);
      });
      const connection = { upstream, downstream: outgoing };
      if (stream) streams.add(connection);
      outgoing.on("close", () => { streams.delete(connection); upstream.destroy(); });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.end(bytes);
    } catch { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay did not get a loopback port");
  return {
    origin: `http://127.0.0.1:${address.port}`, target: target.origin, frames, requests, forbidden,
    cutStreams, resume: () => { blockStreams = false; },
    loseNextForkReply: () => { dropForkReply = true; },
    droppedFork: () => droppedFork,
    close: async () => {
      cutStreams();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
type Relay = Awaited<ReturnType<typeof reconnectRelay>>;

const test = base.extend<{ relay: Relay }>({
  relay: async ({ baseURL, context }, use) => {
    if (!baseURL || !process.env.E2E_ROOT || !process.env.E2E_PROJECT_CWD) throw new Error("Generated fixture environment is required");
    const relay = await reconnectRelay(baseURL);
    const external: string[] = [];
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (["http:", "https:"].includes(url.protocol) && !loopback(url)) {
        external.push(url.origin); return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      localStorage.setItem("pi-locale", "en");
      const probe: Probe = { online: 0, offline: 0, visibility: [] };
      Object.assign(window, { __reconnectProbe: probe });
      window.addEventListener("online", () => { probe.online++; });
      window.addEventListener("offline", () => { probe.offline++; });
      document.addEventListener("visibilitychange", () => { probe.visibility.push(document.visibilityState); });
    });
    try { await use(relay); }
    finally {
      await relay.close();
      expect(relay.forbidden, "No accidental non-fixture prompt may reach the agent").toEqual([]);
      expect(external, "No browser request may contact a remote provider").toEqual([]);
    }
  },
});

function probe(page: Page) { return page.evaluate(() => (window as unknown as { __reconnectProbe: Probe }).__reconnectProbe); }
function id(page: Page) { return new URL(page.url()).searchParams.get("session"); }
async function live(page: Page, relay: Relay, sessionId = id(page)) {
  const response = await page.request.get(`${relay.target}/api/agent/${sessionId}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function begin(page: Page, relay: Relay, mode: "complete" | "delayed" | "error", token: string) {
  await page.goto(`${relay.origin}/?session=${MAIN_ID}`);
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByTestId("model-selector-trigger")).toHaveAttribute("data-catalog-status", "ready");
  await page.getByTestId("model-selector-trigger").click();
  await page.getByRole("option", { name: /E2E deterministic offline model/ }).click();
  const composer = page.locator("textarea").last();
  await composer.fill(`/e2e-reconnect-${mode} ${token}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => id(page)).not.toBe(MAIN_ID);
  await expect.poll(() => id(page)).toBeTruthy();
  expect(await page.evaluate(() => Function.prototype.toString.call(EventSource))).toContain("[native code]");
}
async function completedOnce(page: Page, relay: Relay, token: string) {
  const text = `Fixture completed ${token}.`;
  await expect(page.getByTestId("assistant-message").filter({ hasText: text })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeEnabled();
  await expect.poll(async () => (await live(page, relay)).state?.isStreaming).toBe(false);
  const response = await page.request.get(`${relay.target}/api/sessions/${id(page)}`);
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const matches = body.context.messages.filter((message: any) => message.role === "assistant" && JSON.stringify(message.content).includes(text));
  expect(matches, "The authoritative transcript must contain exactly one completed answer").toHaveLength(1);
}

test("a new session receives an instant completed first turn after its authoritative snapshot", async ({ page, relay }) => {
  const token = "instant-first";
  await begin(page, relay, "complete", token);
  await completedOnce(page, relay, token);
  const create = relay.requests.find(request => request.path === "/api/agent/new");
  expect(create?.body).toMatchObject({ deferPrompt: true, provider: PROVIDER });
  const prompt = relay.requests.find(request => request.path === `/api/agent/${id(page)}` && request.body?.type === "prompt");
  expect(prompt).toBeTruthy();
  expect(relay.frames.slice(0, prompt!.framesBefore).some(frame => frame.event.type === "session_snapshot" && frame.event.sessionId === id(page))).toBe(true);
  expect(relay.frames.some(frame => frame.event.type === "agent_end")).toBe(true);
});

test("a new session retains an instant fixture failure and becomes idle", async ({ page, relay }) => {
  const token = "instant-error";
  await begin(page, relay, "error", token);
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture reconnect failure ${token}` })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await live(page, relay)).state?.isStreaming).toBe(false);
  expect(relay.frames.some(frame => frame.event.type === "agent_end" && JSON.stringify(frame.event.messages).includes(`Fixture reconnect failure ${token}`))).toBe(true);
});

test("transport-only SSE loss replays the missing final events exactly once without an online or visibility event", async ({ page, relay }) => {
  const token = "transport-lost-end";
  await begin(page, relay, "delayed", token);
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture progress ${token}` })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const before = await probe(page);
  const cutAt = relay.frames.length;
  relay.cutStreams();
  await expect.poll(async () => (await live(page, relay)).state?.isStreaming, { timeout: 12_000 }).toBe(false);
  expect(relay.frames.slice(cutAt).some(frame => frame.event.type === "agent_end")).toBe(false);
  relay.resume();
  await completedOnce(page, relay, token);
  expect(await probe(page)).toEqual(before);
  const recovered = relay.frames.slice(cutAt);
  expect(recovered.some(frame => frame.path.includes("cursor=") && frame.event.type === "agent_end")).toBe(true);
  expect(recovered.some(frame => frame.event.type === "session_snapshot" && frame.event.state.isStreaming === false)).toBe(true);
});

test("returning from a native background window reconciles a completed disconnected run", async ({ page, relay }) => {
  const token = "native-background";
  await begin(page, relay, "delayed", token);
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture progress ${token}` })).toHaveCount(1);
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  try {
    relay.cutStreams();
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
    const hiddenAt = Date.now();
    await expect.poll(async () => (await live(page, relay)).state?.isStreaming, { timeout: 12_000 }).toBe(false);
    // The application's real visibility policy intentionally ignores <3s flicks.
    if (Date.now() - hiddenAt < 3100) await new Promise(resolve => setTimeout(resolve, 3100 - (Date.now() - hiddenAt)));
    const requestCount = relay.requests.length;
    relay.resume();
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    await completedOnce(page, relay, token);
    const events = await probe(page);
    expect(events.visibility).toEqual(expect.arrayContaining(["hidden", "visible"]));
    expect(events.online).toBe(0);
    await expect.poll(() => relay.requests.slice(requestCount).some(request => request.path.includes(`/api/sessions/${id(page)}?includeState`))).toBe(true);
  } finally {
    relay.resume();
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => {});
    await cdp.detach();
  }
});

test("lost replacement SSE and POST ACK recover the final runtime from the old native cursor", async ({ page, relay }) => {
  const token = "replacement-before";
  await begin(page, relay, "complete", token);
  await completedOnce(page, relay, token);
  const previous = id(page)!;
  const cutAt = relay.frames.length;
  relay.loseNextForkReply();
  const user = page.locator('[data-message-role="user"]').filter({ hasText: `E2E_RECONNECT:complete:${token}` });
  await user.scrollIntoViewIfNeeded();
  await user.getByRole("button", { name: "New session", exact: true }).click();
  await expect.poll(() => relay.droppedFork()).toMatchObject({ success: true, data: { cancelled: false, newSessionId: expect.any(String) } });
  const next = relay.droppedFork()!.data.newSessionId as string;
  expect(next).not.toBe(previous);
  expect(id(page), "Both replacement identity channels are still blocked").toBe(previous);
  expect(relay.frames.slice(cutAt).some(frame => frame.event.type === "session_replaced")).toBe(false);
  relay.resume();
  await expect.poll(() => id(page), { timeout: 15_000 }).toBe(next);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  const recovered = relay.frames.slice(cutAt);
  expect(recovered.some(frame => frame.path.startsWith(`/api/agent/${previous}/events?cursor=`) && frame.event.type === "session_replaced" && frame.event.newSessionId === next)).toBe(true);
  expect(recovered.some(frame => frame.event.type === "session_snapshot" && frame.event.sessionId === next && frame.event.state.isStreaming === false)).toBe(true);
  expect((await live(page, relay, previous)).running, "Cursor recovery must not reopen the old runtime").toBe(false);
  expect((await live(page, relay, next)).running).toBe(true);
  // Native fork is before the selected user entry: the old answer must not be
  // replayed into the replacement's empty transcript.
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture completed ${token}` })).toHaveCount(0);
});
