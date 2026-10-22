import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { prepareIsolatedAgentDir } from './preview-data.mjs';

export const STREAMING_BENCHMARK_PROVIDER = 'piweb-stream-benchmark';
export const STREAMING_BENCHMARK_MODEL = 'deterministic';
export const STREAMING_BENCHMARK_PROFILES = Object.freeze({
  short: Object.freeze({ paragraphs: 8, chunkCharacters: 24, intervalMs: 2 }),
  long: Object.freeze({ paragraphs: 96, chunkCharacters: 24, intervalMs: 2 }),
});

function validateInput(profile, runId) {
  if (!Object.hasOwn(STREAMING_BENCHMARK_PROFILES, profile)) throw new Error('Unknown offline benchmark profile');
  if (typeof runId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(runId)) throw new Error('Invalid offline benchmark run id');
}

export function makeBenchmarkPrompt(profile, runId) {
  validateInput(profile, runId);
  return `BENCH_STREAM:${profile}:${runId}`;
}

export function makeBenchmarkText(profile, runId) {
  validateInput(profile, runId);
  const paragraphs = STREAMING_BENCHMARK_PROFILES[profile].paragraphs;
  const body = Array.from({ length: paragraphs }, (_, index) =>
    `Paragraph ${index + 1}. **Synthetic streaming** keeps completed prose stable. A fixed sentence grows in small chunks.`,
  ).join('\n\n');
  return `Benchmark ${runId} begins.\n\n${body}\n\nBenchmark ${runId} completed.`;
}

// This exact extension is loaded by the packaged CLI and the Web E2E runtime.
// Its only input and output are the strict synthetic benchmark grammar above.
export function streamingBenchmarkExtensionSource() {
  return `import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
const profiles = ${JSON.stringify(STREAMING_BENCHMARK_PROFILES)};
const provider = ${JSON.stringify(STREAMING_BENCHMARK_PROVIDER)};
const modelId = ${JSON.stringify(STREAMING_BENCHMARK_MODEL)};
const expectedText = ${makeBenchmarkText.toString()};
const STREAMING_BENCHMARK_PROFILES = profiles;
const validateInput = ${validateInput.toString()};

export default function offlineStreamingBenchmark(pi) {
  if (process.env.PIWEB_ENVIRONMENT !== 'fixture') throw new Error('Streaming benchmark provider is fixture-only');
  const guard = Symbol.for('piweb.benchmark.offline-fetch');
  if (!globalThis[guard]) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Offline benchmark blocked remote fetch');
      return originalFetch(input, init);
    };
    globalThis[guard] = true;
  }
  const baseUrl = 'https://stream-benchmark.invalid';
  pi.registerProvider(provider, {
    name: 'Offline streaming benchmark', baseUrl, api: provider,
    apiKey: 'OFFLINE_FIXTURE_NOT_A_CREDENTIAL', authHeader: false,
    models: [{ id: modelId, name: 'Deterministic streaming benchmark (offline)',
      reasoning: false, input: ['text'], contextWindow: 1_000_000, maxTokens: 32768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      if (model.provider !== provider || model.id !== modelId || model.baseUrl !== baseUrl) throw new Error('Unexpected offline benchmark model');
      const stream = createAssistantMessageEventStream();
      const user = [...context.messages].reverse().find(message => message.role === 'user');
      const prompt = typeof user?.content === 'string' ? user.content : (user?.content ?? []).map(part => part.text ?? '').join('');
      const match = /^BENCH_STREAM:(short|long):([a-z0-9-]{1,40})$/.exec(prompt);
      const message = { role: 'assistant', api: model.api, provider, model: modelId,
        content: [], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const pause = milliseconds => new Promise((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); reject(new Error('Offline benchmark aborted')); };
        const timer = setTimeout(() => { options?.signal?.removeEventListener('abort', aborted); resolve(); }, milliseconds);
        if (options?.signal?.aborted) aborted();
        else options?.signal?.addEventListener('abort', aborted, { once: true });
      });
      queueMicrotask(async () => {
        try {
          if (!match) throw new Error('Only synthetic benchmark prompts are accepted');
          // Match the official provider contract: native pre-request hooks run
          // through onPayload, even though this offline provider sends no HTTP.
          await options?.onPayload?.({ benchmark: true }, model);
          const [, profile, runId] = match;
          const text = expectedText(profile, runId);
          const { chunkCharacters, intervalMs } = profiles[profile];
          message.content = [{ type: 'text', text: '' }];
          stream.push({ type: 'start', partial: message });
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          for (let offset = 0; offset < text.length; offset += chunkCharacters) {
            if (options?.signal?.aborted) throw new Error('Offline benchmark aborted');
            const delta = text.slice(offset, offset + chunkCharacters);
            message.content[0].text += delta;
            stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: message });
            if (offset + chunkCharacters < text.length) await pause(intervalMs);
          }
          stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
          stream.push({ type: 'done', reason: 'stop', message });
        } catch (error) {
          message.stopReason = 'error';
          message.errorMessage = error instanceof Error ? error.message : 'Offline benchmark failed';
          stream.push({ type: 'error', reason: 'error', error: message });
        } finally { stream.end(); }
      });
      return stream;
    },
  });
}
`;
}

function realChildDirectory(parent, name) {
  const child = join(parent, name);
  try {
    const info = lstatSync(child);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Benchmark fixture child must be a real directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(child, { mode: 0o700 });
  }
  if (realpathSync(child) !== child) throw new Error('Benchmark fixture child escaped its root');
  return child;
}

/** Install only in a newly allocated fixture root, or an existing generated E2E root. */
export function createStreamingBenchmarkFixture(root) {
  if (!isAbsolute(root) || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error('Streaming benchmark requires a canonical, real fixture root');
  }
  const cwd = realChildDirectory(root, 'demo-project');
  const agentDir = join(root, 'agent');
  prepareIsolatedAgentDir('fixture', { PI_CODING_AGENT_DIR: agentDir }, cwd, homedir());
  const extensionsDir = realChildDirectory(realChildDirectory(cwd, '.pi'), 'extensions');
  const extensionPath = join(extensionsDir, 'streaming-benchmark.js');
  writeFileSync(extensionPath, streamingBenchmarkExtensionSource(), { flag: 'wx', mode: 0o600 });
  return { cwd, agentDir, extensionPath, provider: STREAMING_BENCHMARK_PROVIDER, modelId: STREAMING_BENCHMARK_MODEL };
}
