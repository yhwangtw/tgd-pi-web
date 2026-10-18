import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { retainPreviousRelease } from '../release-retention.mjs';

const roots = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-retention-'))); roots.push(root);
  const plan = { liveDir: join(root, 'live'), stateDir: join(root, 'state'), stageRoot: join(root, 'stages'),
    publicOrigin: 'https://pi.example.test', retention: { backupRoot: join(root, 'backups'), keepPrevious: 1 } };
  await Promise.all([plan.liveDir, plan.stateDir, plan.stageRoot, plan.retention.backupRoot].map(path => mkdir(path)));
  async function backup(tag, letter, complete = true) {
    const targetSha = letter.repeat(40);
    const path = join(plan.retention.backupRoot, `deploy-${tag}-${targetSha.slice(0, 8)}`);
    await mkdir(join(path, 'previous-build'), { recursive: true }); await mkdir(join(path, 'previous-node_modules/next'), { recursive: true });
    await writeFile(join(path, 'previous-build/BUILD_ID'), 'old-build');
    await writeFile(join(path, 'previous-build/required-server-files.json'), JSON.stringify({ config: { env: { PIWEB_BUILD_SHA: 'f'.repeat(40) } } }));
    await writeFile(join(path, 'previous-node_modules/next/package.json'), JSON.stringify({ name: 'next' }));
    await writeFile(join(path, 'operator.json'), JSON.stringify({ previousSha: 'f'.repeat(40), targetSha }));
    const identity = { cwd: plan.liveDir, agentDir: join(root, 'agent'), build: { version: tag.slice(1), sourceSha: targetSha, dirty: false } };
    const receipt = { tag, phase: complete ? 'complete' : 'public-check', deployment: { status: 'done', identity },
      public: complete ? { origin: plan.publicOrigin, checkedAt: tag.slice(1).replaceAll('.', '-') + 'T00:00:00Z', checks: ['running-identity', 'session-list'] } : null };
    await writeFile(join(plan.stateDir, `${tag}.json`), JSON.stringify(receipt));
    return { path, identity, receipt };
  }
  const old = await backup('v2026.10.01', 'a');
  const current = await backup('v2026.10.17', 'b');
  return { root, plan, backup, old, current };
}
it('retains the current rollback pair and removes only older verified builds/modules', async () => {
  const f = await fixture();
  const result = await retainPreviousRelease(f.plan, f.current.identity, f.current.receipt);
  expect(result.removed).toHaveLength(2);
  await expect(access(join(f.old.path, 'previous-build'))).rejects.toThrow();
  await expect(access(join(f.old.path, 'previous-node_modules'))).rejects.toThrow();
  await expect(access(join(f.old.path, 'operator.json'))).resolves.toBeUndefined();
  await expect(access(join(f.current.path, 'previous-build/BUILD_ID'))).resolves.toBeUndefined();
  await expect(access(join(f.current.path, 'previous-node_modules'))).resolves.toBeUndefined();
  expect((await retainPreviousRelease(f.plan, f.current.identity, f.current.receipt)).removed).toEqual([]);
});
it('preserves failed or unverified attempts, manual backups, and symlink targets', async () => {
  const f = await fixture();
  const pending = await f.backup('v2026.10.04', 'c', false);
  const manual = join(f.plan.retention.backupRoot, 'manual-recovery'); await mkdir(manual);
  const outside = join(f.root, 'external'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'safe');
  await rm(f.old.path, { recursive: true }); await symlink(outside, f.old.path);
  const result = await retainPreviousRelease(f.plan, f.current.identity, f.current.receipt);
  expect(result.removed).toEqual([]);
  await expect(access(join(pending.path, 'previous-build/BUILD_ID'))).resolves.toBeUndefined();
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('safe');
  await expect(access(manual)).resolves.toBeUndefined();
});
it('does not delete anything before current public verification or after a live build change', async () => {
  const f = await fixture();
  await expect(retainPreviousRelease(f.plan, f.current.identity, { ...f.current.receipt, public: null })).rejects.toThrow('verified');
  await expect(retainPreviousRelease(f.plan, { ...f.current.identity, build: { ...f.current.identity.build, sourceSha: 'd'.repeat(40) } }, f.current.receipt)).rejects.toThrow('verified');
  await expect(access(join(f.old.path, 'previous-build/BUILD_ID'))).resolves.toBeUndefined();
});
it('preserves all older builds when the retained rollback pair is incomplete', async () => {
  const f = await fixture();
  await rm(join(f.current.path, 'previous-node_modules'), { recursive: true });
  await expect(retainPreviousRelease(f.plan, f.current.identity, f.current.receipt)).rejects.toThrow('not recoverable');
  await expect(access(join(f.old.path, 'previous-build/BUILD_ID'))).resolves.toBeUndefined();
});
it('rejects roots overlapping service data and supports read-only retention previews', async () => {
  const f = await fixture();
  await expect(retainPreviousRelease({ ...f.plan, retention: { backupRoot: f.root, keepPrevious: 1 } }, f.current.identity, f.current.receipt)).rejects.toThrow('overlaps');
  const result = await retainPreviousRelease(f.plan, f.current.identity, f.current.receipt, { dryRun: true });
  expect(result.status).toBe('preview'); expect(result.removed).toHaveLength(2);
  await expect(access(join(f.old.path, 'previous-build/BUILD_ID'))).resolves.toBeUndefined();
});
it('rejects a symlinked artifact without following it during cleanup', async () => {
  const f = await fixture();
  const external = join(f.root, 'external'); await mkdir(external); await writeFile(join(external, 'keep'), 'safe');
  await rm(join(f.old.path, 'previous-build'), { recursive: true });
  await symlink(external, join(f.old.path, 'previous-build'));
  const result = await retainPreviousRelease(f.plan, f.current.identity, f.current.receipt);
  expect(result.removed).toHaveLength(1);
  expect(await readFile(join(external, 'keep'), 'utf8')).toBe('safe');
});

it('preserves older backups if the rollback build does not match its recorded source', async () => {
  const f = await fixture();
  await writeFile(join(f.current.path, 'previous-build/required-server-files.json'), JSON.stringify({ config: { env: { PIWEB_BUILD_SHA: '0'.repeat(40) } } }));
  await expect(retainPreviousRelease(f.plan, f.current.identity, f.current.receipt)).rejects.toThrow('not recoverable');
  await expect(access(join(f.old.path, 'previous-build/BUILD_ID'))).resolves.toBeUndefined();
});

it('can retain an intact external rollback pair without deleting its symlink targets', async () => {
  const f = await fixture();
  for (const name of ['previous-build', 'previous-node_modules']) {
    const source = join(f.current.path, name), external = join(f.root, name);
    await rename(source, external); await symlink(external, source);
  }
  const result = await retainPreviousRelease(f.plan, f.current.identity, f.current.receipt);
  expect(result.removed).toHaveLength(2);
  await expect(access(join(f.root, 'previous-build/BUILD_ID'))).resolves.toBeUndefined();
  await expect(access(join(f.root, 'previous-node_modules/next/package.json'))).resolves.toBeUndefined();
});


it('preserves older directories still referenced by the retained rollback pair', async () => {
  const f = await fixture();
  for (const name of ['previous-build', 'previous-node_modules']) {
    await rm(join(f.current.path, name), { recursive: true });
    await symlink(join(f.old.path, name), join(f.current.path, name));
  }
  const result = await retainPreviousRelease(f.plan, f.current.identity, f.current.receipt);
  expect(result.removed).toEqual([]);
  await expect(access(join(f.current.path, 'previous-build/BUILD_ID'))).resolves.toBeUndefined();
  await expect(access(join(f.current.path, 'previous-node_modules/next/package.json'))).resolves.toBeUndefined();
});

it('preserves older directories still used by the live build or dependencies', async () => {
  const f = await fixture();
  await symlink(join(f.old.path, 'previous-build'), join(f.plan.liveDir, '.next'));
  await symlink(join(f.old.path, 'previous-node_modules'), join(f.plan.liveDir, 'node_modules'));
  const result = await retainPreviousRelease(f.plan, f.current.identity, f.current.receipt);
  expect(result.removed).toEqual([]);
  await expect(access(join(f.plan.liveDir, '.next/BUILD_ID'))).resolves.toBeUndefined();
  await expect(access(join(f.plan.liveDir, 'node_modules/next/package.json'))).resolves.toBeUndefined();
});
