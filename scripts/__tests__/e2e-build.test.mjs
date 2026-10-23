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
  it.each(['source.ts', 'package-lock.json', '.next/app.js', '.next/BUILD_ID'])('refuses changed %s', file => {
    const root = fixture(); recordE2EBuild(root, {});
    writeFileSync(join(root, file), 'different');
    expect(() => verifyE2EBuild(root, {})).toThrow('does not match');
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
});
