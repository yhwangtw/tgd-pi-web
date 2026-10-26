#!/usr/bin/env node
// Pi 1.3 assumes every persisted assistant has usage. Older/imported histories
// can omit it. Keep unknown usage unknown: estimate context and skip absent billing
// metadata instead of fabricating counts or modifying the user's session file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function patchPiHistoryUsage(packageDirs) {
  const changes = [];
  for (const [name, directory] of packageDirs) {
    const { version } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (version !== '1.3.0') throw new Error(`Review historical usage compatibility for ${name}@${version}`);
    const targets = name === '@earendil-works/pi-ai' ? [['dist/utils/estimate.js', 'calculateContextTokens', 'usage', 'return 0;']]
      : [['dist/core/compaction/compaction.js', 'calculateContextTokens', 'usage', 'return 0;'], ['dist/core/usage-totals.js', 'addUsageToTotals', 'totals, usage', 'return;']];
    for (const [path, method, args, fallback] of targets) {
      const file = join(directory, path), source = readFileSync(file, 'utf8');
      const original = `export function ${method}(${args}) {\n`;
      const guarded = `${original}    if (!usage) ${fallback}\n`;
      if (source.includes(guarded)) continue;
      if (source.split(original).length !== 2) throw new Error(`Unexpected Pi history source: ${name}/${path}`);
      changes.push([file, source.replace(original, guarded)]);
    }
  }
  for (const [file, source] of changes) writeFileSync(file, source);
  return changes.length;
}
function packageDir(requireDependency, name) {
  for (const search of requireDependency.resolve.paths(name) ?? []) {
    const directory = join(search, name), file = join(directory, 'package.json');
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) return directory;
  }
  throw new Error(`Cannot locate ${name}`);
}
export function patchInstalledPiHistoryUsage(projectRoot = root) {
  const packages = new Map();
  for (const host of [projectRoot, join(projectRoot, 'node_modules/@earendil-works/pi-coding-agent'), join(projectRoot, 'node_modules/pi-subagents')]) {
    const requireDependency = createRequire(join(host, 'package.json'));
    for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']) {
      const directory = packageDir(requireDependency, name);
      packages.set(directory, [name, directory]);
    }
  }
  const changed = patchPiHistoryUsage([...packages.values()]);
  console.log(`Verified Pi historical usage compatibility (${changed} files patched).`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) patchInstalledPiHistoryUsage();
