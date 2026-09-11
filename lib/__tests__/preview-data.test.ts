import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync, realpathSync, lstatSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareIsolatedAgentDir } from '../../scripts/preview-data.mjs';
import { createFixtures } from '../../e2e/fixtures';

const roots: string[] = [];
const markerName = '.piweb-isolated-agent.json';
const marker = (environment: 'preview' | 'fixture') => ({ schemaVersion: 1, kind: 'pi-web-isolated-agent', environment });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-preview-contract-')));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'repo');
  const agent = join(home, '.pi', 'agent');
  mkdirSync(agent, { recursive: true }); mkdirSync(cwd);
  writeFileSync(join(agent, 'auth.json'), '{"fixture-secret":"never-import"}');
  return { root, home, cwd, agent };
}
describe('isolated preview data', () => {
  it('creates only a private provenance marker without copying real data', () => {
    const { home, cwd, agent } = fixture();
    const target = prepareIsolatedAgentDir('preview', {}, cwd, home)!;
    expect(target).toBe(join(cwd, '.pi-web-preview', 'agent'));
    expect(readdirSync(target)).toEqual([markerName]);
    expect(JSON.parse(readFileSync(join(target, markerName), 'utf8'))).toEqual(marker('preview'));
    expect(lstatSync(join(target, markerName)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(agent, 'auth.json'), 'utf8')).toContain('never-import');
  });
  it('refuses an inherited real PI_CODING_AGENT_DIR before creating preview data', () => {
    const { home, cwd, agent } = fixture();
    expect(() => prepareIsolatedAgentDir('preview', { PI_CODING_AGENT_DIR: agent }, cwd, home)).toThrow(/Unset/);
    expect(existsSync(join(cwd, '.pi-web-preview'))).toBe(false);
  });
  it.each(['same', 'child', 'parent', 'alias'] as const)('refuses fixture %s of the real directory', (kind) => {
    const { root, home, cwd, agent } = fixture();
    let target = kind === 'child' ? join(agent, 'fixture') : kind === 'parent' ? home : agent;
    if (kind === 'alias') { target = join(root, 'alias'); symlinkSync(agent, target); }
    expect(() => prepareIsolatedAgentDir('fixture', { PI_CODING_AGENT_DIR: target }, cwd, home)).toThrow();
    expect(readdirSync(agent)).toEqual(['auth.json']);
  });
  it('resolves parent aliases before mkdir and refuses a hidden shared root', () => {
    const { root, home, cwd, agent } = fixture();
    symlinkSync(agent, join(root, 'alias'));
    expect(() => prepareIsolatedAgentDir('fixture', { PI_CODING_AGENT_DIR: join(root, 'alias', 'nested') }, cwd, home)).toThrow();
    expect(existsSync(join(agent, 'nested'))).toBe(false);
  });
  it('leaves ordinary dev/start data selection unchanged', () => {
    const { home, cwd, agent } = fixture();
    expect(prepareIsolatedAgentDir('production', {}, cwd, home)).toBeUndefined();
    expect(prepareIsolatedAgentDir('development', { PI_CODING_AGENT_DIR: agent }, cwd, home)).toBe(agent);
  });
  it.each(['preview', 'fixture'] as const)('rejects a nonempty unmarked custom production directory for %s without changing it', (environment) => {
    const { root, home, cwd } = fixture();
    const target = join(root, 'custom-production-agent'); mkdirSync(target);
    writeFileSync(join(target, 'schedules.json'), '{"fixture":"do not modify"}');
    const env = environment === 'fixture' ? { PI_CODING_AGENT_DIR: target } : { PIWEB_PREVIEW_DIR: target };
    expect(() => prepareIsolatedAgentDir(environment, env, cwd, home)).toThrow(/provenance/i);
    expect(readdirSync(target)).toEqual(['schedules.json']);
    expect(readFileSync(join(target, 'schedules.json'), 'utf8')).toBe('{"fixture":"do not modify"}');
  });
  it.each(['preview', 'fixture'] as const)('allows a marked %s directory to persist its own data, but never switch modes', (environment) => {
    const { root, home, cwd } = fixture();
    const target = join(root, 'isolated-agent');
    const env = { PI_CODING_AGENT_DIR: target, PIWEB_PREVIEW_DIR: target };
    expect(prepareIsolatedAgentDir(environment, env, cwd, home)).toBe(target);
    writeFileSync(join(target, 'settings.json'), '{"fixture":true}');
    expect(prepareIsolatedAgentDir(environment, env, cwd, home)).toBe(target);
    const other = environment === 'fixture' ? 'preview' : 'fixture';
    expect(() => prepareIsolatedAgentDir(other, env, cwd, home)).toThrow(/provenance/i);
    expect(JSON.parse(readFileSync(join(target, markerName), 'utf8'))).toEqual(marker(environment));
  });
  it.each(['malformed', 'oversized', 'wrong-kind', 'wrong-version', 'directory', 'symlink'] as const)('rejects an invalid %s provenance marker without replacing it', (kind) => {
    const { root, home, cwd } = fixture();
    const target = join(root, 'isolated-agent'); mkdirSync(target);
    const markerPath = join(target, markerName);
    if (kind === 'directory') mkdirSync(markerPath);
    else if (kind === 'symlink') {
      const outside = join(root, 'outside-marker.json'); writeFileSync(outside, JSON.stringify(marker('fixture')));
      symlinkSync(outside, markerPath);
    } else writeFileSync(markerPath, kind === 'malformed' ? '{' : kind === 'oversized' ? ' '.repeat(4097) : JSON.stringify({ ...marker('fixture'), ...(kind === 'wrong-kind' ? { kind: 'production' } : { schemaVersion: 2 }) }));
    const before = lstatSync(markerPath);
    expect(() => prepareIsolatedAgentDir('fixture', { PI_CODING_AGENT_DIR: target }, cwd, home)).toThrow(/provenance/i);
    expect(lstatSync(markerPath).ino).toBe(before.ino);
  });
  it('allows a symlinked protected default root while still protecting its real location', () => {
    const { root, home, cwd, agent } = fixture();
    const relocated = join(root, 'relocated-agent'); renameSync(agent, relocated); symlinkSync(relocated, agent);
    const target = prepareIsolatedAgentDir('preview', {}, cwd, home)!;
    expect(JSON.parse(readFileSync(join(target, markerName), 'utf8'))).toEqual(marker('preview'));
    expect(() => prepareIsolatedAgentDir('fixture', { PI_CODING_AGENT_DIR: relocated }, cwd, home)).toThrow(/real Pi/);
    expect(() => prepareIsolatedAgentDir('fixture', { PI_CODING_AGENT_DIR: join(relocated, 'nested') }, cwd, home)).toThrow(/real Pi/);
    expect(existsSync(join(relocated, 'nested'))).toBe(false);
    expect(readdirSync(relocated)).toEqual(['auth.json']);
  });
  it('protects a dangling relocated production root before any directories are created there', () => {
    const { root, home, cwd, agent } = fixture();
    renameSync(agent, join(root, 'saved-agent'));
    const destination = join(root, 'future-production-agent'); symlinkSync(destination, agent);
    expect(() => prepareIsolatedAgentDir('fixture', { PI_CODING_AGENT_DIR: join(destination, 'nested') }, cwd, home)).toThrow(/real Pi/);
    expect(existsSync(destination)).toBe(false);
    expect(prepareIsolatedAgentDir('preview', {}, cwd, home)).toBe(join(cwd, '.pi-web-preview', 'agent'));
  });
  it('still rejects a symlink target even when its destination has valid provenance', () => {
    const { root, home, cwd } = fixture();
    const target = join(root, 'marked-agent');
    prepareIsolatedAgentDir('fixture', { PI_CODING_AGENT_DIR: target }, cwd, home);
    const alias = join(root, 'alias'); symlinkSync(target, alias);
    expect(() => prepareIsolatedAgentDir('fixture', { PI_CODING_AGENT_DIR: alias }, cwd, home)).toThrow(/symlink/);
  });
  it('the E2E generator claims fixture provenance before populating its own data', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-generated-provenance-'))); roots.push(root);
    const generated = createFixtures(root);
    const target = join(root, 'agent');
    expect(JSON.parse(readFileSync(join(target, markerName), 'utf8'))).toEqual(marker('fixture'));
    expect(lstatSync(join(target, markerName)).mode & 0o777).toBe(0o600);
    expect(prepareIsolatedAgentDir('fixture', { PI_CODING_AGENT_DIR: target }, generated.cwd, join(root, 'home'))).toBe(target);
  });
});
