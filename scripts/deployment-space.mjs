import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const MiB = 1024 ** 2;
export const DEFAULT_MINIMUM_FREE_BYTES = Object.freeze({ build: 3 * 1024 ** 3, prepare: 2 * 1024 ** 3 });
const RECORD_SPACE = 64 * MiB;

export function validateSpaceRequirements(value) {
  if (value === undefined) return DEFAULT_MINIMUM_FREE_BYTES;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([key, bytes]) => !['build', 'prepare'].includes(key) || !Number.isSafeInteger(bytes) || bytes < RECORD_SPACE)) {
    throw new Error('minimumFreeBytes must contain build/prepare byte counts of at least 64 MiB');
  }
  return { ...DEFAULT_MINIMUM_FREE_BYTES, ...value };
}

async function availableSpace(path, read) {
  let existing = resolve(path);
  for (;;) {
    try {
      const space = await read(existing);
      const bytes = Number(space.bavail) * Number(space.bsize);
      if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`Cannot determine available disk space at ${existing}`);
      return bytes;
    } catch (error) {
      const parent = dirname(existing);
      if (error.code !== 'ENOENT' || parent === existing) throw error;
      existing = parent;
    }
  }
}

/** Read-only: refuse expensive work before it can exhaust progress/rollback storage. */
export async function assertDeploymentSpace(plan, phase, dependencies = {}) {
  if (!['records', 'build', 'prepare'].includes(phase)) throw new Error('Unknown deployment space phase');
  const minimum = validateSpaceRequirements(plan.minimumFreeBytes);
  const requirements = new Map();
  const requireSpace = (path, bytes) => {
    if (path) requirements.set(resolve(path), Math.max(requirements.get(resolve(path)) || 0, bytes));
  };
  requireSpace(plan.stateDir, RECORD_SPACE);
  requireSpace(dependencies.tempDir || tmpdir(), RECORD_SPACE);
  if (phase === 'build') requireSpace(plan.stageDir || plan.stageRoot, minimum.build);
  if (phase === 'prepare') requireSpace(plan.liveDir, minimum.prepare);
  const checks = await Promise.all([...requirements].map(async ([path, requiredBytes]) => ({
    path, requiredBytes, availableBytes: await availableSpace(path, dependencies.statfs || statfs),
  })));
  for (const check of checks) {
    if (check.availableBytes < check.requiredBytes) {
      const mib = bytes => Math.ceil(bytes / MiB);
      throw Object.assign(new Error(`Insufficient disk space before deployment ${phase}: ${check.path} has ${mib(check.availableBytes)} MiB free; ${mib(check.requiredBytes)} MiB required. Free space and resume the same tag; no service cutover was attempted.`),
        { code: 'PIWEB_INSUFFICIENT_SPACE', phase, ...check });
    }
  }
  return checks;
}
