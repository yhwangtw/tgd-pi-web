import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createStreamingBenchmarkFixture, makeBenchmarkPrompt, makeBenchmarkText,
  streamingBenchmarkExtensionSource, STREAMING_BENCHMARK_PROVIDER, STREAMING_BENCHMARK_MODEL,
} from '../streaming-benchmark-fixture.mjs';
import { compareBenchmarkReports, createJsonLineReader, runCliBenchmark, summarizeBenchmarkSamples } from '../bench-streaming-runtime.mjs';

const roots = [];
const guard = Symbol.for('piweb.benchmark.offline-fetch');
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete globalThis[guard];
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tempRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'piweb-benchmark-unit-')));
  roots.push(root);
  return root;
}
function fixtureFactory(createStream) {
  const source = streamingBenchmarkExtensionSource()
    .replace("import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';", '')
    .replace('export default function', 'return function');
  return new Function('createAssistantMessageEventStream', source)(createStream);
}

it('uses deterministic synthetic text and rejects unknown or injectable prompts', () => {
  expect(makeBenchmarkPrompt('short', 'sample-001')).toBe('BENCH_STREAM:short:sample-001');
  const short = makeBenchmarkText('short', 'sample-001');
  expect(short).toHaveLength(925);
  expect(short.startsWith('Benchmark sample-001 begins.')).toBe(true);
  expect(short.endsWith('Benchmark sample-001 completed.')).toBe(true);
  expect(makeBenchmarkText('long', 'sample-001').length).toBeGreaterThan(short.length * 10);
  expect(() => makeBenchmarkPrompt('remote', 'sample-001')).toThrow('profile');
  expect(() => makeBenchmarkPrompt('short', '../real-session')).toThrow('run id');
});

it('only installs in isolated fixture data and never replaces an existing extension', async () => {
  const root = await tempRoot();
  const fixture = createStreamingBenchmarkFixture(root);
  expect(fixture).toMatchObject({ provider: STREAMING_BENCHMARK_PROVIDER, modelId: STREAMING_BENCHMARK_MODEL });
  expect(JSON.parse(await readFile(join(fixture.agentDir, '.piweb-isolated-agent.json'), 'utf8'))).toMatchObject({ environment: 'fixture' });
  const before = await readFile(fixture.extensionPath, 'utf8');
  expect(() => createStreamingBenchmarkFixture(root)).toThrow();
  expect(await readFile(fixture.extensionPath, 'utf8')).toBe(before);
  const occupied = await tempRoot();
  await mkdir(join(occupied, 'agent'));
  await writeFile(join(occupied, 'agent', 'existing.txt'), 'inert fixture data');
  expect(() => createStreamingBenchmarkFixture(occupied)).toThrow('provenance');
});

it('refuses a symlinked project resource directory before writing outside the fixture', async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  await mkdir(join(root, 'demo-project'));
  await symlink(outside, join(root, 'demo-project', '.pi'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => createStreamingBenchmarkFixture(root)).toThrow('real directory');
  await expect(readFile(join(outside, 'extensions', 'streaming-benchmark.js'), 'utf8')).rejects.toThrow();
});

it('generated provider stays offline and streams exactly the shared synthetic text', async () => {
  vi.useFakeTimers();
  vi.stubEnv('PIWEB_ENVIRONMENT', 'fixture');
  const fetch = vi.fn(() => Promise.resolve('loopback-only'));
  vi.stubGlobal('fetch', fetch);
  const events = [];
  const end = vi.fn();
  const provider = vi.fn();
  fixtureFactory(() => ({ push: event => events.push(event), end }))({ registerProvider: provider });
  expect(() => globalThis.fetch('https://example.invalid')).toThrow('blocked remote fetch');
  expect(fetch).not.toHaveBeenCalled();
  await globalThis.fetch('http://127.0.0.1:30177');
  expect(fetch).toHaveBeenCalledTimes(1);
  const config = provider.mock.calls[0][1];
  const model = { provider: STREAMING_BENCHMARK_PROVIDER, id: STREAMING_BENCHMARK_MODEL, baseUrl: config.baseUrl, api: config.api };
  const onPayload = vi.fn(async (payload, selected) => {
    expect(events).toHaveLength(0);
    expect(payload).toEqual({ benchmark: true });
    expect(selected).toBe(model);
  });
  config.streamSimple(model, { messages: [{ role: 'user', content: makeBenchmarkPrompt('short', 'sample-001') }] }, { onPayload });
  await vi.runAllTimersAsync();
  expect(events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe(makeBenchmarkText('short', 'sample-001'));
  expect(events.filter(event => event.type === 'text_delta')).toHaveLength(39);
  expect(events.at(-1).type).toBe('done');
  expect(end).toHaveBeenCalledOnce();
  expect(onPayload).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('honors a native before-request rejection before emitting any synthetic delta', async () => {
  vi.stubEnv('PIWEB_ENVIRONMENT', 'fixture');
  const events = [];
  const provider = vi.fn();
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  fixtureFactory(() => ({ push: event => events.push(event), end: () => finished() }))({ registerProvider: provider });
  const config = provider.mock.calls[0][1];
  const model = { provider: STREAMING_BENCHMARK_PROVIDER, id: STREAMING_BENCHMARK_MODEL, baseUrl: config.baseUrl, api: config.api };
  config.streamSimple(model, { messages: [{ role: 'user', content: makeBenchmarkPrompt('short', 'sample-001') }] }, {
    onPayload: async () => { throw new Error('Synthetic request rejected'); },
  });
  await done;
  expect(events.map(event => event.type)).toEqual(['error']);
  expect(events[0].error.errorMessage).toBe('Synthetic request rejected');
});

it('rejects loading the provider outside fixture mode', () => {
  vi.stubEnv('PIWEB_ENVIRONMENT', 'production');
  const registerProvider = vi.fn();
  expect(() => fixtureFactory(vi.fn())({ registerProvider })).toThrow('fixture-only');
  expect(registerProvider).not.toHaveBeenCalled();
});

it('frames JSONL on LF only across fragmented records and preserves Unicode separators', () => {
  const records = [];
  const reader = createJsonLineReader(record => records.push(record));
  reader.push('{"text":"synthetic\u2028line');
  reader.push('\u2029separator"}\r\n{"type":');
  reader.push('"agent_settled"}\n');
  reader.finish();
  expect(records).toEqual([{ text: 'synthetic\u2028line\u2029separator' }, { type: 'agent_settled' }]);
  const incomplete = createJsonLineReader(vi.fn());
  incomplete.push('{"text":');
  expect(() => incomplete.finish()).toThrow('incomplete');
});

it('only compares like-for-like offline reports and reports explicit timing deltas', () => {
  const sample = { phase: 'warm', firstDeltaMs: 3, completeMs: 100, agentStartToFirstDeltaMs: 2, agentStartToCompleteMs: 99 };
  const before = { kind: 'pi-web-offline-stream-benchmark', schemaVersion: 1, interface: 'cli-json', profile: 'short', fixtureHash: 'fixed', runs: 2, piVersion: '1.3.0', summary: summarizeBenchmarkSamples([sample]) };
  const after = { ...before, summary: summarizeBenchmarkSamples([{ ...sample, firstDeltaMs: 2, completeMs: 90 }]) };
  expect(compareBenchmarkReports(before, after).phases.warm).toMatchObject({ firstDeltaMs: { before: 3, after: 2, changeMs: -1 }, completeMs: { before: 100, after: 90, changeMs: -10 } });
  expect(() => compareBenchmarkReports(before, { ...after, profile: 'long' })).toThrow('identical');
  expect(() => compareBenchmarkReports(before, { ...after, interface: 'browser' })).toThrow('offline CLI');
});

it('runs the actual project-local Pi 1.3 JSON CLI with isolated cold and warm samples', async () => {
  const report = await runCliBenchmark({ runs: 2 });
  expect(report).toMatchObject({ offline: true, piVersion: '1.3.0', profile: 'short', runs: 2 });
  expect(report.samples.map(sample => sample.phase)).toEqual(['cold', 'warm']);
  expect(report.samples.map(sample => sample.startBoundary)).toEqual(['process-spawn', 'previous-agent-settled']);
  for (const sample of report.samples) {
    expect(sample.outputCharacters).toBe(925);
    expect(sample.deltaEvents).toBe(39);
    expect(sample.firstDeltaMs).toBeGreaterThanOrEqual(0);
    expect(sample.completeMs).toBeGreaterThanOrEqual(sample.firstDeltaMs);
    expect(sample.outputHash).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(report.fixtureHash).toMatch(/^[a-f0-9]{64}$/);
  expect(report.stderr.content).toBe('omitted');
});
