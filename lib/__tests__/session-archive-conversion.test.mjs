import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionContext, SessionManager } from '@earendil-works/pi-coding-agent';
import { applyArchiveDelta, convertArchive, convertAgentDirectory } from '../../scripts/convert-session-archive.mjs';
import { assertSessionArchiveConverted } from '../../scripts/session-archive-guard.mjs';
const dirs = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'sdk-conversion-test-')); dirs.push(path); return path; };
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
const group = '00000000-0000-0000-0000-000000000001';
const created = '2026-10-26T01:00:00.000Z';
const user = value => ({ role: 'user', content: value, timestamp: Date.parse(created) });
const defaults = entries => ({ id: `dw_${group}_1`, entries, agent: { cwd: '/fixture', model: { provider: 'test', modelId: 'fixture' }, thinkingLevel: 'high' }, meta: { name: 'Saved chat', sourceSessionId: 'original' }, workflow: null, created });
const messages = entries => buildSessionContext(entries.slice(1)).messages.filter(m => m.role !== 'system');
function fixture(source, root = 'durable-sessions') {
  mkdirSync(source);
  const directory = join(source, root, group); mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, root === 'durable-sessions' ? 'session.sqlite' : 'agent.sqlite'));
  db.exec(`CREATE TABLE conversations(id INTEGER, record TEXT);
CREATE TABLE entries(id INTEGER, conversation_id INTEGER, record TEXT);
CREATE TABLE documents(id INTEGER, owner_id INTEGER, scope_kind TEXT, kind TEXT, retired_at INTEGER);
CREATE TABLE document_revisions(document_id INTEGER, seq INTEGER, kind TEXT, version INTEGER, content TEXT);`);
  db.prepare('INSERT INTO conversations VALUES(?,?)').run(1, JSON.stringify({ id: 1 }));
  db.prepare('INSERT INTO entries VALUES(?,?,?)').run(10, 1, JSON.stringify({ id: 10, kind: 'pi.user', model: [user('Keep this history')] }));
  const docs = [ ['pi-web.session', { created, name: 'Archive', sourceSessionId: 'source-chat' }], ['pi.agent', { cwd: '/fixture' }], ['pi-web.workflow', { version: 1, goal: { id: 'goal', objective: 'Finish', status: 'active', tokens: 3, automaticRuns: 1 }, plan: null }] ];
  for (const [i, [kind, value]] of docs.entries()) {
    db.prepare('INSERT INTO documents VALUES(?,?,?, ?,NULL)').run(i + 1, 1, 'conversation', JSON.stringify(kind));
    db.prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?)').run(i + 1, 1, 'base', 1, JSON.stringify(value));
  }
  db.close();
  writeFileSync(join(source, 'agent-runs.json'), JSON.stringify({ version: 1, runs: root === 'durable-runs' ? [{ id: group, engine: 'durable', name: 'Background', cwd: '/fixture', createdAt: created, status: 'running', toolNames: [], prompt: 'Task', trigger: 'manual' }] : [] }));
  return directory;
}
describe('offline archive conversion', () => {
  it('decodes all stored delta operations and rejects unsafe/unknown paths', () => {
    const original = { words: 'abc', list: [1, 2], extra: true };
    expect(applyArchiveDelta(original, [['a', ['words'], 'de'], ['t', ['words'], 1], ['p', ['list'], 1, 1, [3, 4]], ['m', ['list'], [2, 0, 1]], ['d', ['extra']], ['s', ['new'], 5]])).toEqual({ words: 'bcde', list: [4, 1, 3], new: 5 });
    expect(original).toEqual({ words: 'abc', list: [1, 2], extra: true });
    expect(applyArchiveDelta(original, [['r', { replacement: 1 }]])).toEqual({ replacement: 1 });
    expect(() => applyArchiveDelta({}, [['s', ['__proto__', 'polluted'], true]])).toThrow();
    expect(() => applyArchiveDelta({}, [['unknown', ['x']]])).toThrow();
  });
  it('retains archived SDK branches, IDs, active leaf, model and paused workflow', () => {
    const old = [ { type: 'message', id: 'root', parentId: null, timestamp: created, message: user('Root') }, { type: 'message', id: 'other', parentId: 'root', timestamp: created, message: user('Other branch') }, { type: 'message', id: 'selected', parentId: 'root', timestamp: created, message: user('Selected branch') } ];
    const input = defaults([{ id: 9, kind: 'pi-web.legacy-context', head: 9, data: { header: { type: 'session', version: 3, id: 'original', cwd: '/fixture', timestamp: created }, entries: old, leafId: 'selected' } }, { id: 10, kind: 'pi.user', model: [user('New')] }]);
    input.workflow = { version: 1, goal: { id: 'g', objective: 'Goal', status: 'active', tokens: 5, automaticRuns: 2, tokenBudget: 30 }, plan: { title: 'Steps', status: 'ready', steps: [{ text: 'Read', status: 'pending' }], previousTools: ['read'] } };
    const result = convertArchive(input);
    expect(result[0]).toMatchObject({ id: input.id, sourceSessionId: 'original' });
    expect(result.find(e => e.id === 'other').parentId).toBe('root');
    expect(result.find(e => e.id === 'durable:9').parentId).toBe('selected');
    expect(messages(result).map(m => m.content)).toEqual(['Root', 'Selected branch', 'New']);
    expect(result.find(e => e.customType === 'pi-web-workflow-v1').data).toMatchObject({ goal: { status: 'paused', tokenBudget: 30 }, plan: { status: 'ready' } });
    expect(buildSessionContext(result.slice(1))).toMatchObject({ model: input.agent.model, thinkingLevel: 'high' });
  });
  it('preserves tool calls, results, and image payloads in native SDK format', () => {
    const raw = { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'x' } }], provider: 'test', model: 'fixture', timestamp: 1 };
    const result = convertArchive(defaults([{ id: 1, model: [user([{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }]), raw, { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'ok' }], timestamp: 2 }] }]));
    expect(messages(result)[0].content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' });
    expect(messages(result)[1].content[0]).toEqual(raw.content[0]);
    expect(messages(result)[2].toolCallId).toBe('call');
  });
  it('retains original edited history separately from effective context', () => {
    const result = convertArchive(defaults([{ id: 1, model: [user('original')] }, { id: 2, edits: [{ target: 1, action: 'replace', messages: [user('edited')] }] }, { id: 3, model: [user('latest')] }]));
    expect(result.find(e => e.id === '1').message.content).toBe('original');
    expect(messages(result).map(m => m.content)).toEqual(['edited', 'latest']);
  });
  it('keeps excluded shell output out of context and applies edits from older heads', () => {
    const result = convertArchive(defaults([{ id: 1, kind: 'pi-web.extension-message', data: { customType: 'x', content: 'before', display: true }, model: [user('before')] },
      { id: 2, kind: 'pi-web.shell', data: { command: 'secret', output: 'private', excludeFromContext: true } },
      { id: 3, head: 1, edits: [{ target: 1, action: 'replace', messages: [user('after')] }] }, { id: 4, head: 1 }]));
    expect(messages(result).map(m => m.content)).toEqual(['after']);
    expect(JSON.stringify(messages(result))).not.toContain('private');
  });
  it('preserves incomplete tool history while synthesizing a missing result for context only', () => {
    const result = convertArchive(defaults([{ id: 1, model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'lost', name: 'read', arguments: {} }], timestamp: 1 }] }]));
    expect(messages(result)).toHaveLength(2);
    expect(messages(result)[1]).toMatchObject({ role: 'toolResult', toolCallId: 'lost', isError: true });
    expect(result.find(e => e.id === '1').message.content[0].id).toBe('lost');
  });
  it('converts compaction heads without restoring discarded history to context', () => {
    const result = convertArchive(defaults([{ id: 1, model: [user('discarded')] }, { id: 2, model: [user('kept')] }, { id: 3, kind: 'pi.compaction', head: 2, model: [user('summary')] }, { id: 4, model: [user('new')] }]));
    expect(result.find(e => e.id === '1').message.content).toBe('discarded');
    expect(JSON.stringify(messages(result))).not.toContain('discarded');
    expect(JSON.stringify(messages(result))).toContain('summary');
    expect(JSON.stringify(messages(result))).toContain('kept');
  });
  it('dry run changes no files; execute publishes new verified JSONL and preserves source', () => {
    const base = temporary(), source = join(base, 'old'), output = join(base, 'new');
    const groupDir = fixture(source), before = readFileSync(join(groupDir, 'session.sqlite'));
    expect(() => assertSessionArchiveConverted(source)).toThrow(/retired/);
    expect(convertAgentDirectory(source, output)).toMatchObject({ sessions: 1, executed: false });
    expect(existsSync(output)).toBe(false);
    expect(convertAgentDirectory(source, output, true)).toMatchObject({ sessions: 1, executed: true });
    expect(readFileSync(join(groupDir, 'session.sqlite'))).toEqual(before);
    expect(existsSync(join(output, 'durable-sessions'))).toBe(false);
    expect(() => assertSessionArchiveConverted(output)).not.toThrow();
    const manifest = JSON.parse(readFileSync(join(output, 'session-conversion.json'), 'utf8'));
    const path = join(output, manifest.converted[0].path);
    const session = SessionManager.open(path);
    expect(session.getSessionId()).toBe(`dw_${group}_1`);
    expect(session.buildSessionContext().messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'Keep this history' }));
    expect(() => convertAgentDirectory(source, output, true)).toThrow(/new sibling/);
  });
  it('reads a crash-style WAL archive without creating SHM or changing source bytes', () => {
    const base = temporary(), source = join(base, 'crash-archive'), output = join(base, 'converted');
    const writerDirectory = fixture(join(base, 'writer'));
    const writerPath = join(writerDirectory, 'session.sqlite');
    const writer = new DatabaseSync(writerPath);
    const sourceDirectory = join(source, 'durable-sessions', group);
    mkdirSync(sourceDirectory, { recursive: true });
    try {
      writer.exec('PRAGMA journal_mode=WAL');
      writer.prepare('INSERT INTO entries VALUES(?,?,?)').run(11, 1, JSON.stringify({ id: 11, kind: 'pi.user', model: [user('Only present in the WAL')] }));
      for (const suffix of ['', '-wal']) copyFileSync(`${writerPath}${suffix}`, join(sourceDirectory, `session.sqlite${suffix}`));
    } finally { writer.close(); }
    writeFileSync(join(source, 'agent-runs.json'), JSON.stringify({ version: 1, runs: [] }));
    const snapshot = () => Object.fromEntries(readdirSync(sourceDirectory).sort().map(name => [name, readFileSync(join(sourceDirectory, name))]));
    const before = snapshot();
    expect(Object.keys(before)).toEqual(['session.sqlite', 'session.sqlite-wal']);
    expect(convertAgentDirectory(source, output)).toMatchObject({ sessions: 1, executed: false });
    expect(snapshot()).toEqual(before);
    expect(existsSync(output)).toBe(false);
    expect(convertAgentDirectory(source, output, true)).toMatchObject({ sessions: 1, executed: true });
    expect(snapshot()).toEqual(before);
    const manifest = JSON.parse(readFileSync(join(output, 'session-conversion.json'), 'utf8'));
    const session = SessionManager.open(join(output, manifest.converted[0].path));
    expect(session.buildSessionContext().messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'Only present in the WAL' }));
  });
  it('converts standalone background archives and marks unfinished records interrupted', () => {
    const base = temporary(), source = join(base, 'old'), output = join(base, 'new');
    fixture(source, 'durable-runs');
    expect(() => assertSessionArchiveConverted(source)).toThrow();
    convertAgentDirectory(source, output, true);
    const store = JSON.parse(readFileSync(join(output, 'agent-runs.json'), 'utf8'));
    expect(store.runs[0]).toMatchObject({ status: 'interrupted', sessionId: `dw_${group}_1` });
    expect(store.runs[0].engine).toBeUndefined();
    expect(existsSync(join(output, 'durable-runs'))).toBe(false);
  });
  it('refuses live archive locks, symlinked data and nested output without source writes', () => {
    const base = temporary(), source = join(base, 'old'), output = join(base, 'new');
    fixture(source);
    mkdirSync(join(source, 'durable-sessions', `${group}.lock`));
    expect(() => convertAgentDirectory(source, output, true)).toThrow(/Stop/);
    rmSync(join(source, 'durable-sessions', `${group}.lock`), { recursive: true });
    const outside = join(base, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(source, 'sessions'));
    expect(() => convertAgentDirectory(source, output, true)).toThrow(/symlink/);
    expect(readdirSync(outside)).toEqual([]);
    expect(() => convertAgentDirectory(source, join(source, 'nested'), true)).toThrow();
    expect(existsSync(output)).toBe(false);
  });
});
