import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { patchUndiciRuntime } from '../patch-undici-runtime.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(version, source) {
  const dir = mkdtempSync(join(tmpdir(), 'undici-runtime-test-')); dirs.push(dir);
  mkdirSync(join(dir, 'lib/interceptor'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(dir, 'lib/interceptor/decompress.js'), source);
  return dir;
}

describe('undici optional runtime compatibility', () => {
  it('keeps the memory-bound Zstd decoder when available and omits it otherwise, idempotently', () => {
    const dir = fixture('8.12.3', 'return {gzip: createGunzip, zstd: createZstdDecompress.bind(null, { params: { [constants.ZSTD_d_windowLogMax]: 23 } })}');
    expect(patchUndiciRuntime(dir)).toBe(true);
    expect(patchUndiciRuntime(dir)).toBe(false);
    const source = readFileSync(join(dir, 'lib/interceptor/decompress.js'), 'utf8');
    const evaluate = new Function('createGunzip', 'createZstdDecompress', 'constants', source);
    const gzip = () => 'gzip';
    expect(evaluate(gzip, undefined, {}).gzip()).toBe('gzip');
    expect(evaluate(gzip, undefined, {})).not.toHaveProperty('zstd');
    expect(evaluate(gzip, value => value, { ZSTD_d_windowLogMax: 100 }).zstd()).toEqual({ params: { 100: 23 } });
  });

  it('refuses an unreviewed 8.x version or changed source without changing its bytes', () => {
    for (const [version, source] of [['8.12.4', 'untouched'], ['8.12.3', 'changed']]) {
      const dir = fixture(version, source);
      expect(() => patchUndiciRuntime(dir)).toThrow();
      expect(readFileSync(join(dir, 'lib/interceptor/decompress.js'), 'utf8')).toBe(source);
    }
    expect(patchUndiciRuntime(fixture('7.30.1', 'untouched'))).toBe(false);
  });

  it('loads both actual Pi and subagent HTTP clients without Zstd, retaining gzip support', () => {
    const script = `
      const {createRequire} = require('node:module');
      const zlib = require('node:zlib');
      zlib.createZstdDecompress = undefined;
      for (const dependency of ['@earendil-works/pi-coding-agent', 'pi-subagents']) {
        const req = createRequire(require('node:path').join(process.cwd(), 'node_modules', dependency, 'package.json'));
        const undici = req('undici');
        if (typeof undici.ProxyAgent !== 'function' || typeof undici.interceptors.decompress() !== 'function') throw new Error('Missing HTTP APIs');
      }
      if (zlib.gunzipSync(zlib.gzipSync('compatible')).toString() !== 'compatible') throw new Error('gzip broken');
      console.log('compatible');
    `;
    expect(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim()).toBe('compatible');
  });
});
