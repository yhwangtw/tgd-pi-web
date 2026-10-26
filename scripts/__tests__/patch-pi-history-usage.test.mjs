import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { patchPiHistoryUsage } from '../patch-pi-history-usage.mjs';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(name, version = '1.3.0') {
  const root = mkdtempSync(join(tmpdir(), 'pi-usage-patch-')); roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version }));
  const sources = name === '@earendil-works/pi-ai' ? { 'dist/utils/estimate.js': 'export function calculateContextTokens(usage) {\n    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;\n}' }
    : { 'dist/core/compaction/compaction.js': 'export function calculateContextTokens(usage) {\n    return usage.totalTokens;\n}', 'dist/core/usage-totals.js': 'export function addUsageToTotals(totals, usage) {\n    totals.input += usage.input;\n}' };
  for (const [path, source] of Object.entries(sources)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); }
  return { package: [name, root], sources };
}
describe('pinned SDK history usage guard', () => {
  it('patches only absent usage and is idempotent across both SDK packages', () => {
    const ai = fixture('@earendil-works/pi-ai'), sdk = fixture('@earendil-works/pi-coding-agent');
    expect(patchPiHistoryUsage([ai.package, sdk.package])).toBe(3);
    expect(patchPiHistoryUsage([ai.package, sdk.package])).toBe(0);
    const source = readFileSync(join(ai.package[1], 'dist/utils/estimate.js'), 'utf8').replace('export ', '');
    const calculate = new Function(source + '; return calculateContextTokens;')();
    expect(calculate(undefined)).toBe(0); expect(calculate(null)).toBe(0);
    expect(calculate({ input: 2, output: 3, cacheRead: 4, cacheWrite: 1 })).toBe(10);
    expect(calculate({ totalTokens: 123 })).toBe(123);
  });
  it('refuses unreviewed versions before writing any package', () => {
    const ai = fixture('@earendil-works/pi-ai'), sdk = fixture('@earendil-works/pi-coding-agent', '1.4.0');
    expect(() => patchPiHistoryUsage([ai.package, sdk.package])).toThrow(/Review/);
    expect(readFileSync(join(ai.package[1], 'dist/utils/estimate.js'), 'utf8')).toBe(ai.sources['dist/utils/estimate.js']);
  });
  it('rejects unexpected source instead of marking a patch as successful', () => {
    const ai = fixture('@earendil-works/pi-ai');
    writeFileSync(join(ai.package[1], 'dist/utils/estimate.js'), 'changed source');
    expect(() => patchPiHistoryUsage([ai.package])).toThrow(/Unexpected/);
    expect(readFileSync(join(ai.package[1], 'dist/utils/estimate.js'), 'utf8')).toBe('changed source');
  });
});
