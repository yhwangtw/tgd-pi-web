import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processAlive } from './runtime-guard.mjs';

const ID = /^update-[a-f0-9-]{36}$/;
const ACTIVE = new Set(['reserved', 'running', 'verifying']);
const STATES = new Set([...ACTIVE, 'succeeded', 'failed', 'verification_failed', 'interrupted']);
const GRACE_MS = 30_000;
const filename = (root, id) => {
  if (!ID.test(id)) throw new Error('Invalid update operation id');
  return join(root, `${id}.json`);
};

async function safeRoot(root, create = false) {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe update operation directory');
}

async function readJson(path) {
  if ((await lstat(path)).isSymbolicLink()) throw new Error('Unsafe update operation file');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function withStoreMutex(root, action) {
  const mutex = join(root, '.store-mutex');
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await mkdir(mutex, { mode: 0o700 }); acquired = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await new Promise(done => setTimeout(done, 10));
  }
  if (!acquired) throw Object.assign(new Error('Update operation store is busy or needs operator mutex recovery'), { code: 'UPDATE_OPERATION_CONFLICT' });
  // Never guess whether a crashed owner is safe to reclaim. A leftover mutex
  // fails closed until an operator verifies all update processes are stopped.
  try { return await action(); }
  finally { await rmdir(mutex); }
}

export async function readUpdateOperation(root, id) {
  await safeRoot(root);
  const record = await readJson(filename(root, id));
  if (record.id !== id || !STATES.has(record.status) || !['update', 'restart', 'rollback'].includes(record.action)
    || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string'
    || typeof record.cwd !== 'string' || !Number.isSafeInteger(record.pid)) throw new Error('Invalid update operation record');
  return record;
}

export async function reserveUpdateOperation(root, input) {
  await safeRoot(root, true);
  return withStoreMutex(root, async () => {
  const id = `update-${randomUUID()}`;
  const now = new Date().toISOString();
  const record = { ...input, id, status: 'reserved', pid: process.pid, createdAt: now, updatedAt: now };
  try {
    await writeFile(join(root, 'active.lock'), `${JSON.stringify({ id })}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw Object.assign(new Error('Another managed update operation is active; refresh its status before trying again'), { code: 'UPDATE_OPERATION_CONFLICT' });
  }
  try { await writeJson(filename(root, id), record); }
  catch (error) { await releaseLocked(root, id); throw error; }
  return record;
  });
}

export async function patchUpdateOperation(root, id, patch) {
  const previous = await readUpdateOperation(root, id);
  const record = { ...previous, ...patch, id: previous.id, createdAt: previous.createdAt, updatedAt: new Date().toISOString() };
  await writeJson(filename(root, id), record);
  return record;
}

async function releaseLocked(root, id) {
  const path = join(root, 'active.lock');
  try { if ((await readJson(path)).id === id) await unlink(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function releaseUpdateOperation(root, id) {
  await safeRoot(root);
  return withStoreMutex(root, () => releaseLocked(root, id));
}

export async function finishUpdateOperation(root, id, status, message, extra = {}) {
  if (ACTIVE.has(status) || !STATES.has(status)) throw new Error('Expected a terminal update status');
  const record = await patchUpdateOperation(root, id, { ...extra, status, message, finishedAt: new Date().toISOString() });
  await releaseUpdateOperation(root, id);
  return record;
}

export async function listUpdateOperations(root) {
  try { await safeRoot(root); } catch (error) {
    if (error.code === 'ENOENT') return { active: null, recent: [] };
    throw error;
  }
  return withStoreMutex(root, async () => {
  let active = null;
  let lockFound = false;
  try {
    const lock = await readJson(join(root, 'active.lock'));
    lockFound = true;
    active = await readUpdateOperation(root, lock.id);
    if (ACTIVE.has(active.status) && Date.now() - Date.parse(active.updatedAt) > GRACE_MS
      && !processAlive(active.pid) && !processAlive(active.helperPid)) {
      // The supervisor can die between spawn and durable helper-PID capture.
      // A dead known PID is not proof that no detached mutation is still alive.
      active = await patchUpdateOperation(root, active.id, { status: 'interrupted', requiresRecovery: true,
        message: 'Supervisor interrupted; verify the deployment and helper processes before operator lock recovery' });
    } else if (!ACTIVE.has(active.status) && !active.requiresRecovery) {
      await releaseLocked(root, active.id);
      active = null;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (lockFound) throw new Error('Incomplete update operation lock; operator recovery is required');
  }
  const ids = (await readdir(root)).filter(name => /^update-[a-f0-9-]{36}\.json$/.test(name));
  const recent = await Promise.all(ids.map(name => readUpdateOperation(root, name.slice(0, -5))));
  recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { active, recent: recent.slice(0, 20) };
  });
}

export async function writeExpectedUpdateIdentity(root, id, identity) {
  await readUpdateOperation(root, id);
  await writeJson(join(root, `${id}.expected.json`), identity);
}

export async function readExpectedUpdateIdentity(root, id) {
  filename(root, id);
  try { return await readJson(join(root, `${id}.expected.json`)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
