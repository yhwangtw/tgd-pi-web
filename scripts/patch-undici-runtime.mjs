#!/usr/bin/env node

// undici 8.12.3 requires Node >=22.19, but Node 23.4 predates zlib's Zstd
// backport. Keep the security fixes and omit only unsupported Zstd decoding.
// Remove this narrow workaround once upstream guards the optional API.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const original = 'zstd: createZstdDecompress.bind(null, { params: { [constants.ZSTD_d_windowLogMax]: 23 } })';
const guarded = `...(typeof createZstdDecompress === 'function' ? { ${original} } : {})`;

export function patchUndiciRuntime(packageDir) {
  const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  if (!version.startsWith('8.')) return false;
  if (version !== '8.12.3') throw new Error(`Review undici runtime compatibility before using ${version}`);
  const file = join(packageDir, 'lib/interceptor/decompress.js');
  const source = readFileSync(file, 'utf8');
  if (source.includes(guarded)) return false;
  if (source.split(original).length !== 2) throw new Error('Unexpected undici decompressor source; refusing to patch');
  writeFileSync(file, source.replace(original, guarded));
  return true;
}

export function patchInstalledUndici(projectRoot = root) {
  const packages = new Set();
  for (const dependency of ['@earendil-works/pi-coding-agent', 'pi-subagents']) {
    const requireDependency = createRequire(join(projectRoot, 'node_modules', dependency, 'package.json'));
    packages.add(dirname(requireDependency.resolve('undici/package.json')));
  }
  for (const packageDir of packages) patchUndiciRuntime(packageDir);
  console.log('Verified undici optional Zstd runtime compatibility.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) patchInstalledUndici();
