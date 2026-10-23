import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordE2EBuild, verifyE2EBuild } from '../e2e-build.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-e2e-build-')); roots.push(root);
  writeFileSync(join(root, '.gitignore'), '.next/\n');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);
  mkdirSync(join(root, '.next/cache'), { recursive: true });
  writeFileSync(join(root, '.next/BUILD_ID'), 'build-123');
  writeFileSync(join(root, '.next/app.js'), 'built application');
  return root;
}
describe('shared CI E2E build', () => {
  it('verifies across checkout locations and ignores only mutable cache/trace files', () => {
    const root = fixture();
    recordE2EBuild(root, { CI: 'true' });
    writeFileSync(join(root, '.next/cache/mutable'), 'cache');
    writeFileSync(join(root, '.next/trace'), 'trace');
    expect(verifyE2EBuild(root, { CI: 'true' }).buildId).toBe('build-123');
    const copy = mkdtempSync(join(tmpdir(), 'pi-e2e-copy-')); roots.push(copy);
    cpSync(root, copy, { recursive: true });
    expect(verifyE2EBuild(copy, { CI: 'true' }).buildId).toBe('build-123');
  });
  it('allows runtime response cache writes while still checking the full compiled artifact', () => {
    const root = fixture();
    const route = join(root, '.next/server/app');
    const runtimeCache = join(root, '.next/server/route-cache/APP_PAGE/source/$/index.segments');
    mkdirSync(route, { recursive: true });
    writeFileSync(join(route, 'page.js'), 'compiled route');
    writeFileSync(join(route, 'index.html'), 'immutable prerender seed');
    recordE2EBuild(root, {});
    mkdirSync(runtimeCache, { recursive: true });
    writeFileSync(join(runtimeCache, '_full.segment.rsc'), 'first response');
    expect(verifyE2EBuild(root, {}).buildId).toBe('build-123');
    writeFileSync(join(runtimeCache, '_full.segment.rsc'), 'next response');
    expect(verifyE2EBuild(root, {}).buildId).toBe('build-123');
    writeFileSync(join(route, 'page.js'), 'tampered compiled route');
    expect(() => verifyE2EBuild(root, {})).toThrow('differing fields: build;');
    writeFileSync(join(route, 'page.js'), 'compiled route');
    rmSync(join(route, 'index.html'));
    expect(() => verifyE2EBuild(root, {})).toThrow('differing fields: build;');
  });
  it.each(['static/route-cache/response', 'server/route-cache'])('does not exempt %s as a runtime cache directory', file => {
    const root = fixture();
    const target = join(root, '.next', file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, 'original artifact');
    recordE2EBuild(root, {});
    writeFileSync(target, 'changed artifact');
    expect(() => verifyE2EBuild(root, {})).toThrow('differing fields: build;');
  });
  it.each([
    ['source.ts', 'source'],
    ['package-lock.json', 'source'],
    ['.next/app.js', 'build'],
    ['.next/BUILD_ID', 'buildId, build'],
  ])('refuses changed %s and identifies the mismatch', (file, fields) => {
    const root = fixture(); recordE2EBuild(root, {});
    writeFileSync(join(root, file), 'different');
    expect(() => verifyE2EBuild(root, {})).toThrow(`differing fields: ${fields};`);
  });
  it('records unstaged source deletions and invalidates reuse when paths return or disappear', () => {
    const root = fixture();
    recordE2EBuild(root, {});
    rmSync(join(root, 'source.ts'));
    expect(() => verifyE2EBuild(root, {})).toThrow('differing fields: source;');
    recordE2EBuild(root, {});
    expect(verifyE2EBuild(root, {}).buildId).toBe('build-123');
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
    expect(() => verifyE2EBuild(root, {})).toThrow('differing fields: source;');
  });
  it('rejects changed build environment and Node/platform without storing environment values', () => {
    const root = fixture(); recordE2EBuild(root, { NEXT_PUBLIC_EXAMPLE: 'fixture-private-value' });
    const path = join(root, '.next/piweb-e2e-build.json');
    expect(readFileSync(path, 'utf8')).not.toContain('fixture-private-value');
    expect(() => verifyE2EBuild(root, { NEXT_PUBLIC_EXAMPLE: 'changed' })).toThrow('does not match');
    const saved = JSON.parse(readFileSync(path, 'utf8')); saved.platform = 'other';
    writeFileSync(path, JSON.stringify(saved));
    expect(() => verifyE2EBuild(root, { NEXT_PUBLIC_EXAMPLE: 'fixture-private-value' })).toThrow('does not match');
  });
  it('refuses missing or incomplete artifacts rather than bypassing the build', () => {
    const root = fixture();
    expect(() => verifyE2EBuild(root, {})).toThrow();
    writeFileSync(join(root, '.next/BUILD_ID'), '');
    expect(() => recordE2EBuild(root, {})).toThrow('completed production build');
  });
  it('reports all mismatched fields without disclosing stored or current values', () => {
    const root = fixture();
    recordE2EBuild(root, { NEXT_PUBLIC_EXAMPLE: 'stored-private-value' });
    writeFileSync(join(root, 'source.ts'), 'changed-private-source');
    let message;
    try { verifyE2EBuild(root, { NEXT_PUBLIC_EXAMPLE: 'current-private-value' }); }
    catch (error) { message = error.message; }
    expect(message).toContain('does not match');
    expect(message).toContain('differing fields: source, environment;');
    expect(message).not.toMatch(/stored-private-value|current-private-value|changed-private-source/);
    const saved = JSON.parse(readFileSync(join(root, '.next/piweb-e2e-build.json'), 'utf8'));
    expect(message).not.toContain(saved.source);
    expect(message).not.toContain(saved.environment);
  });
  it('still rejects unknown or reordered manifest metadata', () => {
    const root = fixture();
    const saved = recordE2EBuild(root, {});
    const path = join(root, '.next/piweb-e2e-build.json');
    for (const value of [{ ...saved, extra: 'private-extra-value' }, Object.fromEntries(Object.entries(saved).reverse())]) {
      writeFileSync(path, JSON.stringify(value));
      expect(() => verifyE2EBuild(root, {})).toThrow('differing fields: manifest metadata;');
    }
  });
});
