import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { command } from './release-policy.mjs';

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
  hash.update(JSON.stringify({ schema: 2, stageDir: root, expected: plan.expected, build,
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
        for await (const chunk of createReadStream(resolved)) hash.update(chunk);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function walk(path) {
    const name = relative(root, path);
    if (name === '.next/cache') return;
    const info = await lstat(path);
    hash.update(JSON.stringify([name, info.mode & 0o777]));
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      if (!artifactRoots.some(path => target === path || target.startsWith(`${path}/`))) throw new Error('Candidate dependency/build symlink escapes fingerprinted artifacts');
      hash.update(`link:${await readlink(path)}`);
    } else if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry));
    } else if (info.isFile()) {
      hash.update(`file:${info.size}:`);
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    } else throw new Error('Unexpected candidate build file type');
  }
  await walk(join(root, '.next'));
  await walk(join(root, 'node_modules'));
  return hash.digest('hex');
}
