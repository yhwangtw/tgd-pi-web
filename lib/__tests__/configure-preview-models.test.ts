import { afterEach, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurePreviewModels } from '../../scripts/configure-preview-models.mjs';
import { prepareIsolatedAgentDir } from '../../scripts/preview-data.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-preview-models-'))); roots.push(root);
  const home = join(root, 'home'); const cwd = join(root, 'repo'); const source = join(home, '.pi', 'agent');
  mkdirSync(source, { recursive: true }); mkdirSync(cwd);
  writeFileSync(join(source, 'models.json'), JSON.stringify({ providers: { fixture: { apiKey: 'fixture-not-real', models: [] } } }));
  writeFileSync(join(source, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-only' } }), { mode: 0o600 });
  writeFileSync(join(source, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture-model', packages: ['/never-copy'], extensions: ['/never-copy'] }));
  writeFileSync(join(source, 'schedules.json'), 'do not copy'); mkdirSync(join(source, 'sessions'));
  return { source, home, cwd };
}
it('explicitly connects models and login while keeping histories, schedules and extensions separate', () => {
  const fixture = setup();
  const result = configurePreviewModels(fixture);
  expect(realpathSync(join(result.target, 'auth.json'))).toBe(join(fixture.source, 'auth.json'));
  expect(lstatSync(join(result.target, 'auth.json')).isSymbolicLink()).toBe(true);
  expect(lstatSync(join(result.target, 'models.json')).mode & 0o777).toBe(0o600);
  expect(lstatSync(result.backup).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(join(result.target, 'settings.json'), 'utf8'))).toEqual({ defaultProvider: 'fixture', defaultModel: 'fixture-model' });
  expect(existsSync(join(result.target, 'sessions'))).toBe(false);
  expect(existsSync(join(result.target, 'schedules.json'))).toBe(false);
  expect(readFileSync(join(result.target, 'models.json'), 'utf8')).toContain('fixture-not-real');
});
it('backs up existing preview settings without changing the source or preview-only preferences', () => {
  const fixture = setup();
  const target = prepareIsolatedAgentDir('preview', {}, fixture.cwd, fixture.home)!;
  writeFileSync(join(target, 'settings.json'), '{"theme":"dark","defaultModel":"old"}');
  writeFileSync(join(target, 'auth.json'), '{}');
  const before = readFileSync(join(fixture.source, 'auth.json'), 'utf8');
  const result = configurePreviewModels(fixture);
  expect(readFileSync(join(result.backup, 'auth.json'), 'utf8')).toBe('{}');
  expect(readFileSync(join(result.backup, 'settings.json'), 'utf8')).toContain('old');
  expect(readFileSync(join(target, 'settings.json'), 'utf8')).toContain('dark');
  expect(readFileSync(join(fixture.source, 'auth.json'), 'utf8')).toBe(before);
});
it('does not connect an unmarked nonempty directory or a fixture directory', () => {
  const fixture = setup();
  const target = join(fixture.cwd, 'existing'); mkdirSync(target); writeFileSync(join(target, 'sessions.json'), 'private');
  expect(() => configurePreviewModels({ ...fixture, env: { PIWEB_PREVIEW_DIR: target } })).toThrow(/provenance/);
  const testTarget = join(fixture.cwd, 'fixture');
  prepareIsolatedAgentDir('fixture', { PI_CODING_AGENT_DIR: testTarget }, fixture.cwd, fixture.home);
  expect(() => configurePreviewModels({ ...fixture, env: { PIWEB_PREVIEW_DIR: testTarget } })).toThrow(/provenance/);
});
