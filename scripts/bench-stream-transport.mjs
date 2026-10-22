#!/usr/bin/env node
// Synthetic offline benchmark. Example: node scripts/bench-stream-transport.mjs 0f8a31ba
// Reads the specified Git baseline; never modifies a checkout or reads agent data.
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length !== 3) throw new Error('Usage: node scripts/bench-stream-transport.mjs <baseline-commit>');
const baseline = execFileSync('git', ['rev-parse', '--verify', `${process.argv[2]}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const wireUrl = moduleUrl(readFileSync(resolve(root, 'lib/agent-stream-wire.ts'), 'utf8'));
const nativeUrl = moduleUrl(execFileSync('git', ['show', `${baseline}:lib/agent-event-log.ts`], { cwd: root, encoding: 'utf8' }));
const deltaUrl = moduleUrl(readFileSync(resolve(root, 'lib/agent-event-log.ts'), 'utf8').replace('from "./agent-stream-wire"', `from "${wireUrl}"`));
const { AgentEventLog: NativeLog } = await import(nativeUrl);
const { AgentEventLog: DeltaLog } = await import(deltaUrl);
const { AgentStreamTransport, AgentStreamDecoder } = await import(wireUrl);
const count = 1000;
const frames = [];
let text = '';
for (let i = 0; i < count; i++) {
  text += 'x'.repeat(128);
  const message = { role: 'assistant', content: [{ type: 'text', text }], api: 'synthetic', provider: 'offline', model: 'fixture',
    usage: { output: i, cost: { total: i / 1000 } }, timestamp: 1 };
  frames.push({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(128), partial: message } });
}
function median(run) {
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const at = performance.now(); run();
    if (i) samples.push(performance.now() - at); // Exclude JIT warmup.
  }
  return samples.sort((a, b) => a - b)[2];
}
const nativeMs = median(() => { const log = new NativeLog('epoch'); for (const event of frames) log.append(event); });
const deltaMs = median(() => {
  const log = new DeltaLog('epoch'); const transport = new AgentStreamTransport(true);
  for (const event of frames) { const record = log.append(event); transport.select(record, record.type); }
});
const fullFrames = frames.map(event => JSON.stringify(event));
const log = new DeltaLog('epoch'); const transport = new AgentStreamTransport(true);
const deltas = frames.map(event => { const record = log.append(event); return transport.select(record, record.type).data; });
const nativeDecodeMs = median(() => { for (const data of fullFrames) JSON.parse(data); });
const deltaDecodeMs = median(() => {
  const decoder = new AgentStreamDecoder();
  for (let i = 0; i < deltas.length; i++) decoder.decode(JSON.parse(deltas[i]), deltas[i], `epoch:${i + 1}`);
});
const fullBytes = fullFrames.reduce((sum, data) => sum + Buffer.byteLength(data), 0);
const deltaBytes = deltas.reduce((sum, data) => sum + Buffer.byteLength(data), 0);
console.log(JSON.stringify({ node: process.version, baseline, fixture: 'synthetic-sdk-message-and-partial', updates: count, finalCharacters: text.length,
  nativeAppendMs: nativeMs, deltaAppendAndSelectMs: deltaMs, extraEncodeMsPerUpdate: (deltaMs - nativeMs) / count,
  nativeDecodeMs, deltaReconstructAndDecodeMs: deltaDecodeMs, extraDecodeMsPerUpdate: (deltaDecodeMs - nativeDecodeMs) / count,
  fullBytes, deltaBytes, reductionPercent: (1 - deltaBytes / fullBytes) * 100 }, null, 2));
