#!/usr/bin/env node
// Offline synthetic session-list benchmark. Never opens a server or a real agent store.
// node scripts/bench-session-list.mjs [--source-ref <commit>] [--count 3200]
import ts from 'typescript';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const count = Number(option('--count') ?? 3200);
if (!Number.isInteger(count) || count < 3000) throw new Error('--count must be an integer >= 3000');
const sourceRef = option('--source-ref');
const revision = sourceRef ? execFileSync('git', ['rev-parse', '--verify', `${sourceRef}^{commit}`], { cwd: project, encoding: 'utf8' }).trim() : 'working-tree';
const fixture = fs.mkdtempSync(join(tmpdir(), 'pi-session-list-bench-'));
// Set before any application module is imported. Keep late work confined on exit too.
process.env.PI_CODING_AGENT_DIR = fixture;
const libPrefix = pathToFileURL(join(project, 'lib') + '/').href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(libPrefix) && !extname(specifier)) {
      const url = new URL(`${specifier}.ts`, context.parentURL).href;
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(libPrefix) && url.endsWith('.ts')) {
      const path = fileURLToPath(url);
      const source = sourceRef
        ? execFileSync('git', ['show', `${revision}:${path.slice(project.length + 1)}`], { cwd: project, encoding: 'utf8' })
        : fs.readFileSync(path, 'utf8');
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    }
    return next(url, context);
  },
});
const { listAllSessions } = await import(pathToFileURL(join(project, 'lib/session-reader.ts')).href);
const { durableSessionDirectory, durableSessionId, saveDurableProjection } = await import(pathToFileURL(join(project, 'lib/durable-session-store.ts')).href);
const { publishSessionMigration } = await import(pathToFileURL(join(project, 'lib/session-migrations.ts')).href);
const operations = {};
const original = [];
for (const [target, names] of [[fs, ['readFileSync', 'statSync', 'readdirSync']], [fs.promises, ['readFile', 'stat', 'readdir']]]) {
  for (const name of names) {
    const method = target[name];
    original.push(() => { target[name] = method; });
    target[name] = function(path, ...rest) {
      if (String(path).startsWith(fixture + '/')) {
        const kind = String(path).startsWith(join(fixture, 'session-migrations')) ? 'migration' : String(path).startsWith(join(fixture, 'durable-sessions')) ? 'durable' : 'legacy';
        const key = `${kind}.${name}`;
        operations[key] = (operations[key] ?? 0) + 1;
      }
      return method.call(this, path, ...rest);
    };
  }
}
syncBuiltinESMExports();
const iso = n => new Date(1_700_000_000_000 + n).toISOString();
const payload = 'Synthetic offline session. '.repeat(12);
const legacyPath = i => join(fixture, 'sessions', `project-${i % 80}`, `${i}.jsonl`);
function createLegacy(i, extra = '') {
  const path = legacyPath(i);
  fs.mkdirSync(dirname(path), { recursive: true });
  const entries = [{ type: 'session', version: 3, id: `legacy-${i}`, cwd: `/fixture/project-${i % 80}`, timestamp: iso(i) }];
  for (let m = 0; m < 24; m++) entries.push({ type: 'message', id: `m${m}`, parentId: m ? `m${m - 1}` : null,
    timestamp: iso(i * 100 + m), message: { role: m % 2 ? 'assistant' : 'user', content: `${payload}${i}/${m}${extra}`, timestamp: 1_700_000_000_000 + i * 100 + m } });
  fs.writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}
const groupFor = i => `00000000-0000-4000-8000-${String(i % 64).padStart(12, '0')}`;
function createDurable(i) {
  const group = groupFor(i);
  const conversation = Math.floor(i / 64) + 1;
  const id = durableSessionId(group, conversation);
  const entries = Array.from({ length: 24 }, (_, m) => ({ id: m + 1, kind: 'messages', model: [{ role: m % 2 ? 'assistant' : 'user', content: `${payload}${i}/${m}`, timestamp: 1_700_000_000_000 + i * 100 + m }] }));
  saveDurableProjection(durableSessionDirectory(group), conversation, { version: 1, deleted: false,
    info: { id, path: `durable://${id}`, cwd: `/fixture/project-${i % 80}`, created: iso(i), modified: iso(i * 100 + 23), messageCount: 24, firstMessage: `${payload}${i}/0`, lastMessage: `${payload}${i}/23`, lastMessageId: '24' },
    entries, agent: {}, context: { messages: entries.flatMap(entry => entry.model), entryIds: entries.map(entry => String(entry.id)), model: null, thinkingLevel: 'off' } });
  return id;
}
function clearCaches() {
  for (const key of ['__piSessionInfoCache', '__piSessionPathCache', '__piSessionListings', '__piDurableSessionIndex']) globalThis[key] = undefined;
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function sample(expected, repetitions, cold) {
  const times = []; const serializationTimes = []; let responseBytes = 0; let responseHash; let lastOperations;
  for (let iteration = 0; iteration < repetitions; iteration++) {
    if (cold) clearCaches();
    for (const key of Object.keys(operations)) delete operations[key];
    const at = performance.now();
    const sessions = await listAllSessions();
    times.push(performance.now() - at);
    assert.equal(sessions.length, expected);
    assert.equal(new Set(sessions.map(info => info.id)).size, expected);
    assert.ok(sessions.every(info => info.messageCount === 24));
    const serializeAt = performance.now();
    const response = JSON.stringify({ sessions });
    serializationTimes.push(performance.now() - serializeAt);
    responseBytes = Buffer.byteLength(response);
    responseHash = createHash('sha256').update(response.split(fixture).join('<fixture>')).digest('hex');
    lastOperations = { ...operations };
  }
  return { medianMs: Number(median(times).toFixed(2)), minMs: Number(Math.min(...times).toFixed(2)), maxMs: Number(Math.max(...times).toFixed(2)), serializationMedianMs: Number(median(serializationTimes).toFixed(2)), responseBytes, responseHash, operations: lastOperations };
}
const results = [];
try {
  const mixedLegacy = Math.floor(count * 3 / 4);
  for (const [name, legacyCount, durableCount, migrated] of [['legacy', count, 0, false], ['durable', 0, count, false], ['mixed-migrated', mixedLegacy, count - mixedLegacy, true]]) {
    fs.rmSync(join(fixture, 'sessions'), { recursive: true, force: true });
    fs.rmSync(join(fixture, 'durable-sessions'), { recursive: true, force: true });
    fs.rmSync(join(fixture, 'session-migrations'), { recursive: true, force: true });
    clearCaches();
    for (let i = 0; i < legacyCount; i++) createLegacy(i);
    const durableIds = Array.from({ length: durableCount }, (_, i) => createDurable(i));
    const aliases = migrated ? Math.min(100, legacyCount, durableCount) : 0;
    for (let i = 0; i < aliases; i++) publishSessionMigration({ version: 1, sourceId: `legacy-${i}`, sessionId: durableIds[i], sourcePath: legacyPath(i), sourceHash: 'synthetic', migratedAt: iso(0) });
    const expected = legacyCount + durableCount - aliases;
    const cold = await sample(expected, 5, true);
    const warm = await sample(expected, 7, false);
    let changed;
    if (legacyCount) {
      createLegacy(legacyCount - 1, ' externally updated');
      changed = await sample(expected, 1, false);
      assert.ok((await listAllSessions()).find(info => info.id === `legacy-${legacyCount - 1}`).lastMessage.endsWith(' externally updated'));
    }
    results.push({ name, legacy: legacyCount, durable: durableCount, migrated: aliases, returned: expected, cold, warm, ...(changed ? { changed } : {}) });
  }
  console.log(JSON.stringify({ node: process.version, revision, fixture: 'synthetic-only; OS page cache not cleared; 24 messages per session; full response', count, results }, null, 2));
} finally {
  for (const restore of original) restore();
  syncBuiltinESMExports();
  fs.rmSync(fixture, { recursive: true, force: true });
}
