import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { deploymentFingerprint } from '../deployment-fingerprint.mjs';
import { command } from '../release-policy.mjs';

const roots = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const stageDir = await realpath(await mkdtemp(join(tmpdir(), 'pi-build-fingerprint-')));
  const operatorDir = await realpath(await mkdtemp(join(tmpdir(), 'pi-build-adapter-')));
  roots.push(stageDir, operatorDir);
  await writeFile(join(operatorDir, 'build.mjs'), '// build adapter\n');
  await writeFile(join(operatorDir, 'service.mjs'), '// service adapter\n');
  const git = args => command('git', args, stageDir);
  git(['init', '--quiet']);
  await writeFile(join(stageDir, '.gitignore'), '.next/\nnode_modules/\n');
  await writeFile(join(stageDir, 'adapter.mjs'), '// original operator adapter\n');
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  await mkdir(join(stageDir, '.next/cache'), { recursive: true });
  await mkdir(join(stageDir, 'node_modules'));
  await writeFile(join(stageDir, '.next/BUILD_ID'), 'same-build-id');
  await writeFile(join(stageDir, '.next/server.js'), 'original build');
  await writeFile(join(stageDir, 'node_modules/dependency.js'), 'original dependency');
  const plan = { stageDir, expected: { sourceSha: git(['rev-parse', 'HEAD']) }, commands: {
    build: [process.execPath, join(operatorDir, 'build.mjs')],
    stop: [process.execPath, join(operatorDir, 'service.mjs'), 'stop'],
  } };
  return { stageDir, operatorDir, plan, git };
}
it('invalidates executable artifacts and dependencies even when BUILD_ID is unchanged', async () => {
  const { stageDir, plan } = await fixture();
  const first = await deploymentFingerprint(plan, { NODE_ENV: 'test' });
  await writeFile(join(stageDir, '.next/cache/transient'), 'mutable cache');
  expect(await deploymentFingerprint(plan, { NODE_ENV: 'test' })).toBe(first);
  await writeFile(join(stageDir, '.next/server.js'), 'changed build');
  const changed = await deploymentFingerprint(plan, { NODE_ENV: 'test' });
  expect(changed).not.toBe(first);
  await writeFile(join(stageDir, 'node_modules/dependency.js'), 'changed dependency');
  expect(await deploymentFingerprint(plan, { NODE_ENV: 'test' })).not.toBe(changed);
  expect(await readFile(join(stageDir, '.next/BUILD_ID'), 'utf8')).toBe('same-build-id');
});
it('invalidates changed build environment and refuses dirty or escaping candidates', async () => {
  const { stageDir, plan } = await fixture();
  expect(await deploymentFingerprint(plan, { PATH: '/a' })).not.toBe(await deploymentFingerprint(plan, { PATH: '/b' }));
  await symlink(tmpdir(), join(stageDir, 'node_modules/outside'));
  await expect(deploymentFingerprint(plan, {})).rejects.toThrow('escapes');
  await rm(join(stageDir, 'node_modules/outside'));
  await writeFile(join(stageDir, 'adapter.mjs'), '// changed source');
  await expect(deploymentFingerprint(plan, {})).rejects.toThrow('source changed');
});
it('reuses a build after service-only repairs, but invalidates changed build adapter bytes and arguments', async () => {
  const { operatorDir, plan } = await fixture();
  const first = await deploymentFingerprint(plan, {});
  await writeFile(join(operatorDir, 'service.mjs'), '// fix orphaned service shutdown');
  expect(await deploymentFingerprint(plan, {})).toBe(first);
  const changedService = { ...plan, liveIdentityUrl: 'http://127.0.0.1:30141/api/runtime/identity',
    minimumFreeBytes: { prepare: 256 * 1024 ** 2 }, commands: { ...plan.commands, stop: [process.execPath, '/different/stop.mjs'] } };
  expect(await deploymentFingerprint(changedService, {})).toBe(first);
  await writeFile(join(operatorDir, 'build.mjs'), '// changed build configuration');
  const changedBuild = await deploymentFingerprint(plan, {});
  expect(changedBuild).not.toBe(first);
  expect(await deploymentFingerprint({ ...plan, commands: { ...plan.commands, build: [...plan.commands.build, '--new-option'] } }, {})).not.toBe(changedBuild);
});
