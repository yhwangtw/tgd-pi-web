import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { makeBenchmarkPrompt, makeBenchmarkText, streamingBenchmarkExtensionSource } from "../../scripts/streaming-benchmark-fixture.mjs";

type Observation = {
  runId: string; started: number; firstDomMs?: number; firstSentenceMs?: number; completeDomMs?: number;
  eventBytes: number; deltaFrames: number; fullUpdates: number;
  timing?: Record<string, unknown>;
};
declare global { interface Window { piBenchmark?: Observation; } }
const round = (value: number) => Math.round(value * 100) / 100;
const RUNS = Number(process.env.PI_STREAM_BENCHMARK_RUNS || 5);
if (!Number.isInteger(RUNS) || RUNS < 2 || RUNS > 20) throw new Error("Benchmark requires 2..20 runs");

test.beforeEach(async ({ context, baseURL }) => {
  if (!process.env.PI_STREAM_BENCHMARK_READY || !baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Requires the opt-in loopback benchmark fixture");
  const origin = new URL(baseURL).origin;
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) return route.abort();
    if (url.pathname.endsWith("/summarize")) return route.fulfill({ json: { skipped: true, reason: "offline-benchmark" } });
    return route.continue();
  });
  await context.addInitScript(() => {
    localStorage.setItem("pi-locale", "en");
    localStorage.setItem("pi-ui-style", "original");
    // Observe Chromium's native EventSource; do not fabricate, delay or replace frames.
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("message", event => {
          const run = window.piBenchmark;
          if (!run?.started) return;
          run.eventBytes += new TextEncoder().encode(event.data).length;
          const frame = JSON.parse(event.data);
          if (frame.type === "message_update_delta") run.deltaFrames++;
          if (frame.type === "message_update") run.fullUpdates++;
        });
      }
    };
    window.addEventListener("pi-run-latency", event => {
      const run = window.piBenchmark;
      if (run?.started) run.timing = (event as CustomEvent).detail;
    });
    document.addEventListener("click", event => {
      const button = (event.target as Element)?.closest?.('button[aria-label="Send"]');
      if (button && window.piBenchmark) window.piBenchmark.started = performance.now();
    }, true);
    const observer = new MutationObserver(() => {
      const run = window.piBenchmark;
      if (!run?.started || run.completeDomMs !== undefined) return;
      const messages = document.querySelectorAll('[data-testid="assistant-message"]');
      const text = messages[messages.length - 1]?.textContent ?? "";
      if (text.includes(`Benchmark ${run.runId}`)) run.firstDomMs ??= performance.now() - run.started;
      if (text.includes(`Benchmark ${run.runId} begins.`)) run.firstSentenceMs ??= performance.now() - run.started;
      if (text.includes(`Benchmark ${run.runId} completed.`)) run.completeDomMs = performance.now() - run.started;
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true });
  });
});

async function send(page: Page, profile: "short" | "long", runId: string) {
  await page.getByRole("textbox", { name: "Message…", exact: true }).fill(makeBenchmarkPrompt(profile, runId));
  await page.evaluate(runId => { window.piBenchmark = { runId, started: 0, eventBytes: 0, deltaFrames: 0, fullUpdates: 0 }; }, runId);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const answer = page.getByTestId("assistant-message").filter({ hasText: `Benchmark ${runId} completed.` });
  await expect(answer).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  const observation = await page.evaluate(() => window.piBenchmark!);
  expect(observation.firstDomMs).toBeGreaterThan(0);
  expect(observation.firstSentenceMs).toBeGreaterThanOrEqual(observation.firstDomMs!);
  expect(observation.completeDomMs).toBeGreaterThanOrEqual(observation.firstSentenceMs!);
  // Markdown formatting changes textContent, so validate native authoritative
  // content separately; the UI must also retain every paragraph exactly once.
  const id = new URL(page.url()).searchParams.get("session");
  const context = await (await page.request.get(`/api/sessions/${id}/context`)).json();
  const messages = context.context.messages.filter((message: any) => message.role === "assistant");
  const text = messages.at(-1).content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
  expect(text).toBe(makeBenchmarkText(profile, runId));
  const paragraphs = profile === "short" ? 8 : 96;
  for (let index = 1; index <= paragraphs; index++) await expect(answer.getByText(`Paragraph ${index}.`, { exact: false })).toHaveCount(1);
  return { ...observation, started: undefined, firstDomMs: round(observation.firstDomMs!), firstSentenceMs: round(observation.firstSentenceMs!), completeDomMs: round(observation.completeDomMs!), outputCharacters: text.length,
    outputHash: createHash("sha256").update(text).digest("hex") };
}

for (const engine of ["sdk"] as const) for (const profile of ["short", "long"] as const) {
  test(`${engine} ${profile}: offline first DOM and completion`, async ({ page, browser }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const createStart = performance.now();
    const response = await page.request.post("/api/agent/new", { data: { cwd: process.env.E2E_PROJECT_CWD, engine,
      deferPrompt: true, provider: "piweb-stream-benchmark", modelId: "deterministic", type: "prompt", message: "", toolNames: [] } });
    expect(response.ok(), await response.text()).toBe(true);
    const id = (await response.json()).sessionId;
    const sessionSetupMs = round(performance.now() - createStart);
    const openStart = performance.now();
    await page.goto(`/?session=${id}`);
    await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
    const viewReadyMs = round(performance.now() - openStart);
    const samples = [];
    for (let sample = 1; sample <= RUNS; sample++) {
      const runId = `sample-${String(sample).padStart(3, "0")}`;
      samples.push({ sample, phase: sample === 1 ? "first-precreated" : "warm", ...await send(page, profile, runId) });
    }
    expect(errors).toEqual([]);
    const median = (values: number[]) => { values.sort((a, b) => a - b); const mid = Math.floor(values.length / 2); return round(values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2); };
    const warm = samples.slice(1);
    const report = { kind: "pi-web-offline-browser-benchmark", browser: browser.version(), engine, profile, runs: RUNS,
      fixtureHash: createHash("sha256").update(streamingBenchmarkExtensionSource()).digest("hex"),
      sessionSetupMs, viewReadyMs, samples,
      warmMedian: { firstDomMs: median(warm.map(sample => sample.firstDomMs)), firstSentenceMs: median(warm.map(sample => sample.firstSentenceMs)), completeDomMs: median(warm.map(sample => sample.completeDomMs)) },
      definitions: {
        scope: "Real Chromium, offline deterministic provider; no claims about production/model/TUI speed.",
        firstDomMs: "Send click capture to the first emitted text chunk in the assistant DOM (its unique run marker fits in that chunk), observed by MutationObserver. Not physical display paint.",
        firstSentenceMs: "Send click to the complete first sentence in DOM. It spans two synthetic chunks, so it measures progress delivery after the eager first chunk.",
        completeDomMs: "Send click to final marker in DOM; authoritative message also validated exactly. Runtime settlement can happen later.",
        sessionSetupMs: "Node clock API creation of a fresh session/runtime. Measured separately from browser click/DOM; not a cold-process comparison.",
        warm: "Later prompts in the same precreated session, with growing synthetic history. First prompt is excluded from warm median.",
        timing: "Optional local stage diagnostic; missing on the old baseline. Client and server clocks must not be subtracted.",
      } };
    const reportPath = info.outputPath("measurements.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await info.attach(`${engine}-${profile}.json`, { path: reportPath, contentType: "application/json" });
    console.log(JSON.stringify({ benchmark: `${engine}-${profile}`, sessionSetupMs, viewReadyMs, warmMedian: report.warmMedian }));
    if (process.env.PI_STREAM_EXPECT_TIMING === "1") {
      for (const sample of samples) {
        expect(sample.timing).toMatchObject({ status: "completed", server: { accepted: expect.any(Number) } });
        expect(sample.timing?.firstContentMs).toEqual(expect.any(Number));
        expect(sample.timing?.firstCommitMs).toEqual(expect.any(Number));
        expect((sample.timing?.server as Record<string, unknown>)?.provider_request).toEqual(expect.any(Number));
      }
      if (engine === "legacy" || profile === "long") expect(samples.reduce((sum, sample) => sum + sample.deltaFrames, 0)).toBeGreaterThan(0);
    }
  });
}
