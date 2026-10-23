import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { command } from './release-policy.mjs';

// Bound descriptors and buffered bytes, including on large dependency trees.
const CONCURRENCY = 8;
async function fileDigest(path, observed) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || (observed && (before.ino !== observed.ino || before.dev !== observed.dev))) {
      throw new Error('Candidate file changed during fingerprinting');
    }
    const hash = createHash('sha256');
    if (before.size <= 1024 * 1024) hash.update(await file.readFile());
    else for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) hash.update(chunk);
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Candidate file changed during fingerprinting');
    }
    return hash.digest('hex');
  } finally { await file.close(); }
}

// A checkpoint refers to actual build/dependency bytes, not merely BUILD_ID.
// Next's mutable cache is not executable deployment content.
export async function deploymentFingerprint(plan, environment = process.env) {
  const root = await realpath(plan.stageDir);
  const git = args => command('git', args, root);
  if (git(['rev-parse', 'HEAD']) !== plan.expected.sourceSha || git(['status', '--porcelain'])) {
    throw new Error('Candidate source changed; prepare a clean candidate before resuming');
  }
  const hash = createHash('sha256');
  // Service adapters and health-check addresses are not build inputs. They run
  // again on every attempt, including when the verified build can be reused.
  const build = plan.commands.build;
  hash.update(JSON.stringify({ schema: 3, stageDir: root, expected: plan.expected, build,
    node: process.version, platform: process.platform, arch: process.arch, environment }));
  const artifactRoots = [join(root, '.next'), join(root, 'node_modules')];
  for (const path of artifactRoots) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Candidate build/dependency roots must be real directories');
  }
  // Hash the executable and file arguments of the build command. Keep build
  // adapters separate from stop/start/rollback scripts to avoid false misses.
  for (const path of [...new Set(build.filter(isAbsolute))].sort()) {
    try {
      const resolved = await realpath(path);
      if ((await lstat(resolved)).isFile()) {
        hash.update(`adapter:${path}:${resolved}:`);
        hash.update(await fileDigest(resolved));
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const records = [];
  const queue = [...artifactRoots];
  async function inspect(path) {
    const name = relative(root, path);
    if (name === '.next/cache') return;
    const info = await lstat(path);
    const record = [name, info.mode & 0o777];
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      if (!artifactRoots.some(path => target === path || target.startsWith(`${path}/`))) throw new Error('Candidate dependency/build symlink escapes fingerprinted artifacts');
      record.push('link', await readlink(path));
    } else if (info.isDirectory()) {
      record.push('directory');
      for (const entry of await readdir(path)) queue.push(join(path, entry));
    } else if (info.isFile()) {
      record.push('file', info.size, await fileDigest(path, info));
    } else throw new Error('Unexpected candidate build file type');
    records.push(record);
  }
  for (let offset = 0; offset < queue.length;) {
    const batch = queue.slice(offset, offset + CONCURRENCY);
    offset += batch.length;
    // Drain every open handle even when one item fails.
    const results = await Promise.allSettled(batch.map(inspect));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  // Read completion order, directory enumeration order and mtimes do not affect
  // identity. Every executable byte is still read; no metadata-only shortcut.
  records.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  for (const record of records) hash.update(JSON.stringify(record));
  if (git(['rev-parse', 'HEAD']) !== plan.expected.sourceSha || git(['status', '--porcelain'])) {
    throw new Error('Candidate source changed during fingerprinting');
  }
  return hash.digest('hex');
}
