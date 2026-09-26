import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { assertDeploymentSpace, validateSpaceRequirements } from '../deployment-space.mjs';

const MiB = 1024 ** 2;
const root = resolve('/space-fixture');
const plan = { stageRoot: join(root, 'stage'), liveDir: join(root, 'live'), stateDir: join(root, 'records') };
const tempDir = join(root, 'temp');
const free = bytes => ({ bavail: bytes, bsize: 1 });

it('fails before installation when the candidate filesystem lacks headroom', async () => {
  const statfs = vi.fn(async path => free(path === plan.stageRoot ? 900 * MiB : 8 * 1024 ** 3));
  await expect(assertDeploymentSpace(plan, 'build', { statfs, tempDir })).rejects.toMatchObject({
    code: 'PIWEB_INSUFFICIENT_SPACE', phase: 'build', path: plan.stageRoot,
    availableBytes: 900 * MiB, requiredBytes: 3 * 1024 ** 3,
  });
});
it('checks prepared-artifact storage and progress/temp storage on their own filesystems', async () => {
  for (const path of [plan.liveDir, plan.stateDir, tempDir]) {
    const statfs = async current => free(current === path ? 16 * MiB : 8 * 1024 ** 3);
    await expect(assertDeploymentSpace(plan, 'prepare', { statfs, tempDir })).rejects.toMatchObject({ path });
  }
});
it('checks the existing parent without creating a missing candidate directory', async () => {
  const stageDir = join(plan.stageRoot, 'new-tag');
  const statfs = vi.fn(async path => {
    if (path === stageDir) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return free(8 * 1024 ** 3);
  });
  await assertDeploymentSpace({ ...plan, stageDir }, 'build', { statfs, tempDir });
  expect(statfs).toHaveBeenCalledWith(plan.stageRoot);
});
it('supports measured clone-adapter budgets without imposing a full rebuild budget on reused artifacts', async () => {
  const statfs = vi.fn(async () => free(512 * MiB));
  const clonePlan = { ...plan, minimumFreeBytes: { prepare: 256 * MiB } };
  await expect(assertDeploymentSpace(clonePlan, 'prepare', { statfs, tempDir })).resolves.toHaveLength(3);
  await expect(assertDeploymentSpace(clonePlan, 'records', { statfs, tempDir })).resolves.toHaveLength(2);
  expect(statfs).not.toHaveBeenCalledWith(plan.stageRoot);
});
it('rejects invalid budgets and fails closed when space cannot be read', async () => {
  for (const budget of [null, [], { build: -1 }, { build: NaN }, { prepare: 0 }, { typo: 123 }, { build: 'large' }]) {
    expect(() => validateSpaceRequirements(budget)).toThrow('minimumFreeBytes');
  }
  await expect(assertDeploymentSpace(plan, 'build', { tempDir, statfs: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } })).rejects.toThrow('denied');
  await expect(assertDeploymentSpace(plan, 'build', { tempDir, statfs: async () => ({ bavail: NaN, bsize: 4096 }) })).rejects.toThrow('Cannot determine');
});
