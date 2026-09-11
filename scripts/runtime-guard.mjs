import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function processCwd(pid) {
  if (process.platform === 'linux') {
    try { return await realpath(await readlink(`/proc/${pid}/cwd`)); } catch { return null; }
  }
  try {
    const { stdout } = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5000, maxBuffer: 64 * 1024 });
    const name = stdout.split('\n').find(line => line.startsWith('n'))?.slice(1);
    return name ? await realpath(name) : null;
  } catch { return null; }
}

/** Read-only: markers are hints, but live PID + actual canonical cwd is proof. */
export async function runningCheckoutProcesses(input) {
  const cwd = await realpath(resolve(input));
  const found = new Set();
  const directory = join(cwd, '.piweb-runtime');
  let entries = [];
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe runtime marker directory; setup stopped');
    entries = await readdir(directory);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of entries.filter(value => /^\d+\.json$/.test(value))) {
    const filename = join(directory, name);
    if ((await lstat(filename)).isSymbolicLink()) throw new Error('Unsafe runtime marker file; setup stopped');
    let marker;
    try { marker = JSON.parse(await readFile(filename, 'utf8')); }
    catch { throw new Error('Unreadable runtime marker; setup stopped'); }
    if (typeof marker.cwd !== 'string' || await realpath(marker.cwd).catch(() => null) !== cwd) continue;
    for (const pid of [marker.pid, marker.childPid]) {
      if (!processAlive(pid)) continue;
      const actualCwd = await processCwd(pid);
      if (actualCwd === null && processAlive(pid)) throw new Error('Cannot verify a live runtime marker process; setup stopped');
      if (actualCwd === cwd) found.add(pid);
    }
  }
  // Older npm/Next launches predate markers. Inspect only this user's matching
  // process command and cwd, never environment variables or credential files.
  const args = process.getuid ? ['-U', String(process.getuid()), '-o', 'pid=,command='] : ['-axo', 'pid=,command='];
  const { stdout } = await exec('ps', args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || !/(?:\bnext-server\b|(?:^|[ /])next(?:\.js)?\s+(?:dev|start)\b|scripts\/serve\.mjs)/.test(match[2])) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    const actualCwd = await processCwd(pid);
    if (actualCwd === null && processAlive(pid)) throw new Error('Cannot verify a live Next process working directory; setup stopped');
    if (actualCwd === cwd) found.add(pid);
  }
  return [...found];
}

export async function assertCheckoutStopped(cwd) {
  const running = await runningCheckoutProcesses(cwd);
  if (running.length) throw new Error(`Application checkout is running (PID ${running.join(', ')}). Stop its service first, or use a separately staged deployment; no source or build files were changed.`);
}
