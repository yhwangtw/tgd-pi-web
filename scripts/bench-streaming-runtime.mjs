#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createStreamingBenchmarkFixture, makeBenchmarkPrompt, makeBenchmarkText,
  streamingBenchmarkExtensionSource, STREAMING_BENCHMARK_PROFILES,
  STREAMING_BENCHMARK_PROVIDER, STREAMING_BENCHMARK_MODEL,
} from './streaming-benchmark-fixture.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const round = value => Math.round(value * 1000) / 1000;
const hash = text => createHash('sha256').update(text).digest('hex');
const metrics = ['firstDeltaMs', 'completeMs', 'agentStartToFirstDeltaMs', 'agentStartToCompleteMs'];

export function summarizeBenchmarkSamples(samples) {
  const summarize = selected => Object.fromEntries(metrics.map(name => {
    const values = selected.map(sample => sample[name]).sort((a, b) => a - b);
    if (!values.length) return [name, null];
    const middle = Math.floor(values.length / 2);
    return [name, { min: values[0], median: round(values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2), max: values.at(-1) }];
  }));
  return { cold: summarize(samples.filter(sample => sample.phase === 'cold')), warm: summarize(samples.filter(sample => sample.phase === 'warm')) };
}

export function compareBenchmarkReports(before, after) {
  for (const report of [before, after]) {
    if (report?.kind !== 'pi-web-offline-stream-benchmark' || report.schemaVersion !== 1 || report.interface !== 'cli-json') throw new Error('Only offline CLI benchmark reports can be compared');
  }
  if (before.profile !== after.profile || before.fixtureHash !== after.fixtureHash || before.runs !== after.runs || before.piVersion !== after.piVersion) {
    throw new Error('Comparison requires identical offline profile, fixture, run count and Pi version');
  }
  const result = {};
  for (const phase of ['cold', 'warm']) {
    result[phase] = Object.fromEntries(metrics.map(metric => {
      const previous = before.summary?.[phase]?.[metric]?.median;
      const current = after.summary?.[phase]?.[metric]?.median;
      return [metric, typeof previous === 'number' && Number.isFinite(previous) && typeof current === 'number' && Number.isFinite(current)
        ? { before: previous, after: current, changeMs: round(current - previous) } : null];
    }));
  }
  return { beforeRevision: before.sourceRevision, afterRevision: after.sourceRevision, phases: result,
    caveat: 'Offline runtime and process overhead only; this does not measure real provider speed or terminal/browser paint.' };
}

/** LF-only framing: JSON strings may legitimately contain U+2028/U+2029. */
export function createJsonLineReader(onRecord) {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (line) onRecord(JSON.parse(line));
      }
      if (pending.length > 2_000_000) throw new Error('Offline CLI emitted an oversized protocol record');
    },
    finish() { if (pending.trim()) throw new Error('Offline CLI emitted an incomplete JSONL record'); },
  };
}

export async function runCliBenchmark({ profile = 'short', runs = 5, timeoutMs = 30_000 } = {}) {
  if (!Object.hasOwn(STREAMING_BENCHMARK_PROFILES, profile) || !Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('Use a known profile and 1..20 runs');
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..');
  const packageInfo = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (packageInfo.version !== '1.3.0') throw new Error('This baseline requires the project-local Pi 1.3.0 package');
  const cli = join(packageRoot, 'dist', 'bundle', 'cli.js');
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'piweb-stream-benchmark-')));
  const fixture = createStreamingBenchmarkFixture(fixtureRoot);
  const prompts = Array.from({ length: runs }, (_, index) => makeBenchmarkPrompt(profile, `sample-${String(index + 1).padStart(3, '0')}`));
  const expected = Array.from({ length: runs }, (_, index) => makeBenchmarkText(profile, `sample-${String(index + 1).padStart(3, '0')}`));
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'WINDIR', 'PATHEXT'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  Object.assign(env, { PI_CODING_AGENT_DIR: fixture.agentDir, PIWEB_ENVIRONMENT: 'fixture', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', NO_COLOR: '1' });
  const samples = [];
  let current;
  let previousSettled;
  let failure;
  let stderrBytes = 0;
  const stderrHash = createHash('sha256');
  const started = performance.now();
  const child = spawn(process.execPath, [cli, '--offline', '--mode', 'json', '--no-session', '--no-tools', '--no-mcp', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '-e', fixture.extensionPath,
    '--provider', fixture.provider, '--model', fixture.modelId, '--thinking', 'off', ...prompts], {
    cwd: fixture.cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fail = error => { failure ??= error; child.kill('SIGTERM'); };
  const reader = createJsonLineReader(event => {
    const now = performance.now();
    if (event.type === 'agent_start') {
      if (current || samples.length >= runs) throw new Error('Unexpected offline CLI run sequence');
      current = { index: samples.length, start: previousSettled ?? started, agentStart: now, text: '', deltaEvents: 0 };
    }
    const update = event.assistantMessageEvent;
    if (event.type === 'message_update' && update?.type === 'text_delta' && typeof update.delta === 'string' && update.delta) {
      if (!current) throw new Error('Offline CLI delta arrived outside a run');
      current.firstDelta ??= now;
      current.text += update.delta;
      current.deltaEvents++;
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message;
      if (!current || message.provider !== fixture.provider || message.model !== fixture.modelId || message.stopReason !== 'stop') throw new Error('Offline CLI used an unexpected model or failed');
      const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
      if (text !== expected[current.index] || current.text !== text) throw new Error('Offline CLI synthetic output did not match exactly');
      current.validated = true;
    }
    if (event.type === 'agent_settled') {
      if (!current?.validated || current.firstDelta === undefined || event.aborted) throw new Error('Offline CLI settled without complete synthetic output');
      samples.push({ sample: current.index + 1, phase: current.index === 0 ? 'cold' : 'warm',
        startBoundary: current.index === 0 ? 'process-spawn' : 'previous-agent-settled',
        firstDeltaMs: round(current.firstDelta - current.start), completeMs: round(now - current.start),
        agentStartToFirstDeltaMs: round(current.firstDelta - current.agentStart), agentStartToCompleteMs: round(now - current.agentStart),
        deltaEvents: current.deltaEvents, outputCharacters: current.text.length, outputHash: hash(current.text) });
      previousSettled = now;
      current = undefined;
    }
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { try { reader.push(chunk); } catch (error) { fail(error); } });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; stderrHash.update(chunk); });
  const timeout = setTimeout(() => fail(new Error('Offline CLI benchmark timed out')), timeoutMs);
  let sourceRevision = null;
  let sourceDirty = null;
  try {
    const code = await new Promise((resolveCode, reject) => {
      child.on('error', reject);
      child.on('close', resolveCode);
    });
    clearTimeout(timeout);
    if (failure) throw failure;
    reader.finish();
    if (code !== 0 || current || samples.length !== runs) throw new Error(`Offline CLI benchmark failed (exit ${code}; ${samples.length}/${runs} runs). Diagnostics omitted.`);
    try {
      sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch { /* A copied source snapshot may not contain Git metadata. */ }
    return { kind: 'pi-web-offline-stream-benchmark', schemaVersion: 1, interface: 'cli-json', offline: true,
      piVersion: packageInfo.version, nodeVersion: process.version, sourceRevision, sourceDirty,
      cliHash: hash(await readFile(cli)), fixtureHash: hash(streamingBenchmarkExtensionSource()),
      profile, runs, provider: STREAMING_BENCHMARK_PROVIDER, modelId: STREAMING_BENCHMARK_MODEL,
      schedule: STREAMING_BENCHMARK_PROFILES[profile], samples, summary: summarizeBenchmarkSamples(samples),
      stderr: { bytes: stderrBytes, sha256: stderrHash.digest('hex'), content: 'omitted' },
      definitions: {
        cold: 'First prompt in a new process with a fresh isolated agent directory. OS filesystem caches are not cleared.',
        warm: 'Later predefined prompts in the same Pi process/session, measured from the previous agent_settled record. Synthetic history grows between samples.',
        firstDelta: 'Parent process received the first nonempty JSON text_delta record; this is not terminal paint.',
        complete: 'Parent process received agent_settled after validating the authoritative assistant text and all deltas.',
        scope: 'Offline synthetic runtime/process overhead, including local scheduling. No inference about real provider, network, TUI or browser speed is valid.',
      } };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function main(argv) {
  if (argv.includes('--help')) {
    process.stdout.write('Offline Pi 1.3 CLI JSON stream benchmark. No real provider, global Pi or production session is used.\nUsage: node scripts/bench-streaming-runtime.mjs [--profile short|long] [--runs 5] [--output /tmp/after.json] [--compare /tmp/before.json]\nCold = first prompt/new process, warm = later prompts/same process; OS caches remain warm. Browser DOM timing is a separate real-browser E2E measurement.\n');
    return;
  }
  const options = {};
  let output;
  let compare;
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    const value = argv[++index];
    if (!value) throw new Error('Every benchmark option requires a value');
    if (key === '--profile') options.profile = value;
    else if (key === '--runs') options.runs = Number(value);
    else if (key === '--output') output = value;
    else if (key === '--compare') compare = value;
    else throw new Error('Unknown offline benchmark option');
  }
  if (output && !isAbsolute(output)) throw new Error('Benchmark report output must be an absolute path');
  const before = compare ? JSON.parse(await readFile(compare, 'utf8')) : null;
  const report = await runCliBenchmark(options);
  if (before) report.comparison = compareBenchmarkReports(before, report);
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (output) await writeFile(output, serialized, { flag: 'wx', mode: 0o600 });
  process.stdout.write(serialized);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Offline streaming benchmark failed. No provider output, session data or diagnostics were printed.\n');
    process.exitCode = 1;
  });
}
