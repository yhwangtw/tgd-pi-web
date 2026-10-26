/** Offline legacy archive reader. Uses SQLite + the SDK, never the retired agent engine.
 * All source data stays untouched; conversion publishes a new agent directory atomically.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildSessionContext, convertToLlm, migrateSessionEntries } from '@earendil-works/pi-coding-agent';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const safe = key => typeof key === 'number' && Number.isSafeInteger(key) && key >= 0 || typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key);
/** Decode the archived JSON delta wire format. Reject unknown versions/operations. */
export function applyArchiveDelta(value, operations) {
  let root = clone(value);
  const at = path => path.reduce((v, key) => {
    if (!safe(key) || !v || typeof v !== 'object' || !Object.hasOwn(v, key)) throw new Error('Invalid archive delta path');
    return v[key];
  }, root);
  if (!Array.isArray(operations)) throw new Error('Invalid archive delta');
  for (const op of operations) {
    if (!Array.isArray(op)) throw new Error('Invalid archive delta');
    const [kind, path, argument, count, items] = op;
    if (kind === 'r') { root = clone(path); continue; }
    if (!Array.isArray(path) || !path.every(safe)) throw new Error('Unsafe archive delta path');
    if (kind === 'p' || kind === 'm') {
      const target = at(path);
      if (!Array.isArray(target)) throw new Error('Expected archive array');
      if (kind === 'p') {
        if (!Number.isSafeInteger(argument) || argument < 0 || argument > target.length || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(items)) throw new Error('Invalid archive splice');
        target.splice(argument, count);
        for (let i = 0; i < items.length; i++) target.splice(argument + i, 0, clone(items[i]));
      } else {
        if (!Array.isArray(argument) || argument.length !== target.length || new Set(argument).size !== target.length || !argument.every(i => Number.isInteger(i) && i >= 0 && i < target.length)) throw new Error('Invalid archive permutation');
        const before = target.slice();
        argument.forEach((index, i) => { target[i] = before[index]; });
      }
      continue;
    }
    if (!path.length) throw new Error('Invalid archive root write');
    const parent = at(path.slice(0, -1)), key = path.at(-1);
    if (!parent || typeof parent !== 'object' || Array.isArray(parent) && (typeof key !== 'number' || key >= parent.length)) throw new Error('Invalid archive delta parent');
    if (kind === 's') Object.defineProperty(parent, key, { value: clone(argument), writable: true, enumerable: true, configurable: true });
    else if (kind === 'd') { if (Array.isArray(parent)) parent.splice(key, 1); else delete parent[key]; }
    else if (kind === 'a' && typeof parent[key] === 'string' && typeof argument === 'string') parent[key] += argument;
    else if (kind === 't' && typeof parent[key] === 'string' && Number.isSafeInteger(argument) && argument >= 0) parent[key] = parent[key].slice(argument);
    else throw new Error('Unsupported archive delta operation');
  }
  return root;
}
function document(db, conversationId, kind) {
  const d = db.prepare('SELECT id FROM documents WHERE owner_id = ? AND scope_kind = ? AND kind = ? AND retired_at IS NULL').get(conversationId, 'conversation', JSON.stringify(kind));
  if (!d) return undefined;
  const rows = db.prepare('SELECT kind, version, content FROM document_revisions WHERE document_id = ? ORDER BY seq').all(d.id);
  let value, version;
  for (const r of rows) {
    if (r.kind === 'base') { value = JSON.parse(r.content); version = r.version; }
    else if (r.kind === 'delta' && version === r.version && value !== undefined) value = applyArchiveDelta(value, JSON.parse(r.content));
    else throw new Error('Unsupported archive document revision');
  }
  if (version !== 1) throw new Error('Unsupported archive document version');
  return value;
}
function recordsFor(db, id, upper = Number.MAX_SAFE_INTEGER, visited = new Set()) {
  if (visited.has(id)) throw new Error('Archive ancestry cycle');
  visited.add(id);
  const row = db.prepare('SELECT record FROM conversations WHERE id = ?').get(id);
  if (!row) throw new Error('Missing archive ancestor');
  const c = JSON.parse(row.record);
  const previous = c.parent ? recordsFor(db, c.parent.conversationId, Math.min(upper, c.parent.at), visited) : [];
  return [...previous, ...db.prepare('SELECT record FROM entries WHERE conversation_id = ? AND id <= ? ORDER BY id').all(id, upper).map(r => JSON.parse(r.record))];
}
const messageTime = (message, fallback) => Number.isFinite(message?.timestamp) ? new Date(message.timestamp).toISOString() : fallback;
const text = model => (model ?? []).flatMap(m => typeof m.content === 'string' ? [m.content] : (m.content ?? []).filter(b => b.type === 'text').map(b => b.text)).join('\n');
/** Keep native SDK message fields (toolCall id/name/arguments and image mimeType/data). */
function sdkMessage(raw) {
  const message = clone(raw);
  if (Array.isArray(message.content)) message.content = message.content.map(block => {
    if (block.type === 'image' && block.source) return { type: 'image', mimeType: block.source.media_type, data: block.source.data };
    if (block.type === 'toolCall' && block.toolCallId) return { ...block, id: block.toolCallId, name: block.toolName, arguments: block.input };
    return block;
  });
  return message;
}
export function convertArchive({ id, entries, agent, meta, workflow, created, parentSession }) {
  if (!/^dw_[a-f0-9-]{36}_[1-9][0-9]*$/i.test(id) || !agent?.cwd || !Number.isFinite(Date.parse(created))) throw new Error('Incomplete archive identity');
  const archive = entries.find(e => e.kind === 'pi-web.legacy-context')?.data;
  const prefix = archive ? 'durable:' : '';
  const output = [];
  let parentId = null;
  const append = entry => { output.push(entry); parentId = entry.id; };
  for (const record of entries) {
    const base = { id: `${prefix}${record.id}`, parentId, timestamp: messageTime(record.model?.[0], created) };
    if (record.kind === 'pi-web.legacy-context') {
      const saved = clone(record.data);
      const files = [saved.header, ...saved.entries];
      migrateSessionEntries(files);
      for (const entry of files.slice(1)) append(entry);
      parentId = saved.leafId;
      append({ ...base, parentId, type: 'custom', customType: 'pi-web-migration-boundary' });
    } else if (record.kind === 'pi-web.extension-message') {
      append({ ...base, ...clone(record.data), type: 'custom_message' });
    } else if (record.kind === 'pi-web.extension-entry') {
      append({ ...base, ...clone(record.data), type: 'custom' });
    } else if (record.kind === 'pi-web.shell') {
      append({ ...base, type: 'message', message: { role: 'bashExecution', ...clone(record.data) } });
    } else if (record.kind === 'pi.compaction') {
      append({ ...base, type: 'compaction', summary: text(record.model), firstKeptEntryId: `${prefix}${record.head ?? record.id}`, tokensBefore: 0 });
    } else for (const [i, message] of (record.model ?? []).entries()) {
      if (message.role === 'system') continue;
      append({ ...base, id: i ? `${base.id}:${i}` : base.id, parentId, timestamp: messageTime(message, created), type: 'message', message: sdkMessage(message) });
    }
  }
  // Exact effective context: archived heads/edits may have hidden/replaced history.
  // Keep all original nodes for browsing, then add a separate branch only if needed.
  const marker = entries.findLast(e => e.head !== undefined);
  const range = marker ? entries.filter(e => e.id >= marker.head) : entries;
  const active = marker ? [marker, ...range.filter(e => e.head === undefined)] : range;
  const edits = new Map(range.flatMap(e => (e.edits ?? []).map(edit => [edit.target, edit])));
  const origins = new WeakMap();
  const contributions = active.flatMap(e => {
    const edit = edits.get(e.id);
    if (edit?.action === 'omit') return [];
    const model = edit?.action === 'replace' ? edit.messages : e.model
      ?? (e.kind === 'pi-web.legacy-context' ? convertToLlm(buildSessionContext(e.data.entries, e.data.leafId).messages) : []);
    return model.filter(m => m.role !== 'system' && !(m.role === 'assistant' && ['aborted', 'error', 'deferred'].includes(m.stopReason))).map((m, i) => { const value = sdkMessage(m); if (e.kind !== 'pi-web.legacy-context') origins.set(value, `${prefix}${e.id}${i ? `:${i}` : ''}`); return value; });
  });
  // Retired runtime admitted tool results in call order and synthesized missing
  // results after a crash. Preserve that effective request without rerunning tools.
  const expected = [];
  for (let i = 0; i < contributions.length; i++) {
    const message = contributions[i];
    if (message.role === 'toolResult') continue;
    expected.push(message);
    if (message.role !== 'assistant') continue;
    const results = new Map();
    for (let j = i + 1; j < contributions.length && contributions[j].role !== 'assistant'; j++) {
      const result = contributions[j];
      if (result.role === 'toolResult' && !results.has(result.toolCallId)) results.set(result.toolCallId, result);
    }
    for (const call of message.content.filter(block => block.type === 'toolCall')) {
      expected.push(results.get(call.id) ?? { role: 'toolResult', toolCallId: call.id, toolName: call.name,
        content: [{ type: 'text', text: 'Tool result unavailable: history ends before this call completed.' }],
        isError: true, details: { reason: 'missing_result' }, timestamp: message.timestamp });
    }
  }
  const comparable = messages => JSON.stringify(convertToLlm(messages).filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content, ...(m.role === 'toolResult' ? { toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError } : {}) })));
  if (comparable(buildSessionContext(output).messages) !== comparable(expected)) {
    parentId = null;
    const byId = new Map(output.map(e => [e.id, e]));
    const legacyPath = new Set();
    for (let e = archive?.leafId ? byId.get(archive.leafId) : undefined; e; e = byId.get(e.parentId)) legacyPath.add(e.id);
    const used = new Set();
    expected.forEach((message, i) => {
      const signature = comparable([message]);
      let node = byId.get(origins.get(message));
      if (node?.type !== 'message' || comparable([node.message]) !== signature || used.has(node.id)) node = undefined;
      node ??= output.find(e => legacyPath.has(e.id) && !used.has(e.id) && e.type === 'message' && comparable([e.message]) === signature);
      if (node) { node.parentId = parentId; parentId = node.id; used.add(node.id); }
      else {
        let id = `sdk-active:${i}`;
        while (byId.has(id)) id += ':copy';
        node = { type: 'message', id, parentId, timestamp: messageTime(message, created), message: sdkMessage(message) };
        append(node); byId.set(id, node); used.add(id);
      }
    });
    if (comparable(buildSessionContext(output, parentId).messages) !== comparable(expected)) throw new Error('Converted context does not match archive');
  }
  if (agent.model) append({ type: 'model_change', id: 'sdk-conversion:model', parentId, timestamp: created, ...agent.model });
  append({ type: 'thinking_level_change', id: 'sdk-conversion:thinking', parentId, timestamp: created, thinkingLevel: agent.thinkingLevel ?? 'off' });
  if (workflow) {
    const state = { version: 1, goal: clone(workflow.goal ?? null), plan: clone(workflow.plan ?? null) };
    if (state.goal?.status === 'active') { state.goal.status = 'paused'; state.goal.reason = 'Runtime changed. Use /goal resume to continue.'; }
    append({ type: 'custom', customType: 'pi-web-workflow-v1', data: state, id: 'sdk-conversion:workflow', parentId, timestamp: created });
  }
  if (meta.name) append({ type: 'session_info', name: meta.name, id: 'sdk-conversion:name', parentId, timestamp: created });
  // Reparenting retained nodes around edits/compaction can point at a newly
  // created context node. Publish a topological order, with active metadata last.
  const index = new Map(output.map(e => [e.id, e]));
  if (index.size !== output.length) throw new Error('Duplicate converted history ID');
  const ordered = [], visited = new Set(), visiting = new Set();
  const visit = e => {
    if (visited.has(e.id)) return;
    if (visiting.has(e.id)) throw new Error('Converted history cycle');
    visiting.add(e.id);
    if (e.parentId !== null) { const parent = index.get(e.parentId); if (!parent) throw new Error('Missing converted parent'); visit(parent); }
    visiting.delete(e.id); visited.add(e.id); ordered.push(e);
  };
  output.forEach(visit);
  return [{ type: 'session', version: 3, id, timestamp: created, cwd: agent.cwd, ...(meta.sourceSessionId ? { sourceSessionId: meta.sourceSessionId } : {}), ...(parentSession ? { parentSession } : {}) }, ...ordered];
}
function fingerprint(directory) {
  const result = [];
  const walk = p => { for (const f of readdirSync(p)) { if (f.endsWith('.lock')) continue; const path = join(p, f), s = lstatSync(path); if (s.isDirectory()) walk(path); else if (s.isFile()) result.push([relative(directory, path), hash(readFileSync(path))]); else if (s.isSymbolicLink()) result.push([relative(directory, path), 'symlink', readlinkSync(path)]); else throw new Error('Unsupported agent data file'); } };
  walk(directory);
  return hash(JSON.stringify(result.sort()));
}
export function convertAgentDirectory(source, destination, execute = false) {
  if (!isAbsolute(source) || !isAbsolute(destination)) throw new Error('Use absolute agent/output paths');
  source = realpathSync(source); destination = join(realpathSync(dirname(resolve(destination))), basename(destination));
  // Existing destinations, symlink parents and nesting could overwrite/share the source.
  if (existsSync(destination) || destination.startsWith(`${source}/`) || source.startsWith(`${destination}/`)) throw new Error('Output must be a new sibling directory with a real parent');
  const checkLinks = directory => { for (const item of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, item.name); if (item.isSymbolicLink() && path !== join(source, 'auth.json')) throw new Error('Agent data symlink must be copied to an independent real directory first'); if (item.isDirectory()) checkLinks(path); } };
  checkLinks(source);
  const assertNoLiveLocks = () => {
    if (!execute) return;
    for (const root of ['durable-sessions', 'durable-runs']) {
      const path = join(source, root);
      if (existsSync(path) && readdirSync(path).some(name => name.endsWith('.lock') && Date.now() - lstatSync(join(path, name)).mtimeMs < 60_000)) throw new Error('Stop the archive runtime before conversion');
    }
  };
  assertNoLiveLocks();
  const originalFingerprint = fingerprint(source);
  const converted = [], recoveredRuns = [];
  const existingRuns = existsSync(join(source, 'agent-runs.json')) ? JSON.parse(readFileSync(join(source, 'agent-runs.json'), 'utf8')) : { version: 1, runs: [] };
  const readGroup = (directory, group, filename, backgroundRun) => {
    const path = join(directory, filename);
    if (!existsSync(path)) throw new Error('Archive database missing');
    const scratch = mkdtempSync(join(tmpdir(), 'piweb-archive-read-'));
    let db;
    try {
      cpSync(path, join(scratch, filename));
      if (existsSync(`${path}-wal`)) cpSync(`${path}-wal`, join(scratch, `${filename}-wal`));
      db = new DatabaseSync(join(scratch, filename), { readOnly: true });
      db.exec('BEGIN');
      for (const { id: conversationId } of db.prepare('SELECT id FROM conversations ORDER BY id').all()) {
        const meta = document(db, conversationId, 'pi-web.session') ?? (backgroundRun ? { name: backgroundRun.name, created: backgroundRun.createdAt } : undefined);
        if (meta?.deleted) continue;
        const agent = document(db, conversationId, 'pi.agent');
        if (!meta || !agent) throw new Error('Archive session metadata missing');
        agent.cwd ||= backgroundRun?.cwd;
        const id = `dw_${group}_${conversationId}`;
        const entries = recordsFor(db, conversationId);
        const created = meta.created || entries.find(e => e.kind === 'pi-web.legacy-context')?.data?.header?.timestamp;
        const folder = `--${agent.cwd.replace(/^\//, '').replace(/[^a-zA-Z0-9]/g, '-')}--`;
        const filename = `${new Date(created).toISOString().replace(/:/g, '-')}_${id}.jsonl`;
        converted.push({ id, parentId: meta.parentSessionId, path: join('sessions', folder, filename), files: convertArchive({ id, entries, agent, meta, created, workflow: document(db, conversationId, 'pi-web.workflow') }) });
        if (backgroundRun && !backgroundRun.sessionId) backgroundRun.sessionId = id;
        const child = document(db, conversationId, 'pi-web.durable-subagent');
        if (child?.ownerTaskId) {
          let projection;
          try { projection = JSON.parse(readFileSync(join(directory, `${conversationId}.json`), 'utf8')); } catch { /* DB metadata remains authoritative. */ }
          recoveredRuns.push({ ...(projection?.agentRun ?? {}), id, sessionId: id, engine: 'durable', trigger: 'subagent', name: meta.name || child.agent, cwd: child.cwd, prompt: child.task, toolNames: child.tools,
            limits: child.limits, parentRunId: `dw_${group}_${child.parentConversationId}`, status: child.status, createdAt: created,
            ...(child.startedAt ? { startedAt: new Date(child.startedAt).toISOString() } : {}), ...(child.finishedAt ? { finishedAt: new Date(child.finishedAt).toISOString() } : {}) });
        }
      }
      db.exec('COMMIT');
    } finally { db?.close(); rmSync(scratch, { recursive: true, force: true }); }
  };
  for (const [root, filename] of [['durable-sessions', 'session.sqlite'], ['durable-runs', 'agent.sqlite']]) {
    const groupRoot = join(source, root);
    if (!existsSync(groupRoot)) continue;
    for (const group of readdirSync(groupRoot)) {
      if (group.endsWith('.lock')) {
        if (execute && Date.now() - lstatSync(join(groupRoot, group)).mtimeMs < 60_000) throw new Error('Stop the archive runtime before conversion');
        continue;
      }
      if (!/^[a-f0-9-]{36}$/i.test(group)) throw new Error('Unsupported archive group');
      const backgroundRun = root === 'durable-runs' ? existingRuns.runs?.find(run => run.id === group) : undefined;
      if (root === 'durable-runs' && !backgroundRun) throw new Error('Background archive has no run receipt; preserve source for manual recovery');
      readGroup(join(groupRoot, group), group, filename, backgroundRun);
    }
  }
  const paths = new Map(converted.map(s => [s.id, join(destination, s.path)]));
  for (const session of converted) if (session.parentId && paths.has(session.parentId)) session.files[0].parentSession = paths.get(session.parentId);
  if (fingerprint(source) !== originalFingerprint) throw new Error('Source changed; stop all writers before conversion');
  const result = { version: 1, source, destination, sessions: converted.length, entries: converted.reduce((n, s) => n + s.files.length - 1, 0), executed: execute };
  if (!execute) return result;
  const staging = `${destination}.partial-${randomUUID()}`;
  try {
    mkdirSync(staging, { mode: 0o700 });
    for (const item of readdirSync(source)) if (!['durable-sessions', 'durable-runs'].includes(item) && !item.endsWith('.lock')) cpSync(join(source, item), join(staging, item), { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true });
    const runIds = new Set(existingRuns.runs.map(run => run.id));
    existingRuns.runs.push(...recoveredRuns.filter(run => !runIds.has(run.id)));
    const normalizeRun = (run, interruptedStatus) => {
      if (run.engine !== 'durable') return run;
      delete run.engine; delete run.durableConversation;
      if (['queued', 'running', 'waiting_for_input'].includes(run.status)) {
        run.status = interruptedStatus; run.finishedAt = new Date().toISOString();
        run.error = 'The retired runtime was removed; this historical run will not restart automatically.';
      }
      return run;
    };
    existingRuns.runs = existingRuns.runs.map(run => normalizeRun(run, 'interrupted'));
    writeFileSync(join(staging, 'agent-runs.json'), JSON.stringify(existingRuns), { mode: 0o600 });
    const schedulesPath = join(staging, 'schedules.json');
    if (existsSync(schedulesPath)) {
      const schedules = JSON.parse(readFileSync(schedulesPath, 'utf8'));
      for (const schedule of schedules.schedules ?? []) delete schedule.engine;
      schedules.runs = (schedules.runs ?? []).map(run => normalizeRun(run, 'failed'));
      writeFileSync(schedulesPath, JSON.stringify(schedules), { mode: 0o600 });
    }
    const manifest = [];
    for (const session of converted) {
      const path = join(staging, session.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const content = session.files.map(e => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
      if (hash(readFileSync(path)) !== hash(content)) throw new Error('Output verification failed');
      manifest.push({ id: session.id, path: session.path, sha256: hash(content), entries: session.files.length - 1 });
    }
    // Existing fork headers copied from the old directory must point to the new copy.
    const remapHeaders = directory => {
      if (!existsSync(directory)) return;
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) remapHeaders(path);
        else if (item.isFile() && item.name.endsWith('.jsonl')) {
          const raw = readFileSync(path, 'utf8'), end = raw.indexOf('\n'), header = JSON.parse(end < 0 ? raw : raw.slice(0, end));
          if (typeof header.parentSession === 'string' && header.parentSession.startsWith(`${source}/`)) {
            header.parentSession = join(destination, relative(source, header.parentSession));
            writeFileSync(path, JSON.stringify(header) + (end < 0 ? '\n' : raw.slice(end)), { mode: 0o600 });
          }
        }
      }
    };
    remapHeaders(join(staging, 'sessions'));
    writeFileSync(join(staging, 'session-conversion.json'), JSON.stringify({ ...result, sourceFingerprint: originalFingerprint, converted: manifest }, null, 2), { mode: 0o600 });
    if (fingerprint(source) !== originalFingerprint) throw new Error('Source changed; stop all writers before conversion');
    assertNoLiveLocks();
    renameSync(staging, destination);
    return result;
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) { if (['--agent-dir', '--output'].includes(args[i])) i++; else if (args[i] !== '--execute') throw new Error('Unknown conversion option'); }
    const source = args[args.indexOf('--agent-dir') + 1], output = args[args.indexOf('--output') + 1];
    if (!args.includes('--agent-dir') || !args.includes('--output')) throw new Error('Usage: node scripts/convert-session-archive.mjs --agent-dir /absolute/source --output /absolute/new-agent-dir [--execute]');
    console.log(JSON.stringify(convertAgentDirectory(source, output, args.includes('--execute'))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
