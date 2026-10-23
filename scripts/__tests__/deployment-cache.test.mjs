import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { pruneCandidateCaches } from '../deployment-cache.mjs';
import { command } from '../release-policy.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-cache-prune-'))); roots.push(root);
  const plan = { stageRoot: join(root, 'candidates'), liveDir: join(root, 'live'), stateDir: join(root, 'state'), publicOrigin: 'https://pi.example.test', candidateCache: { keep: 1 } };
  const identity = { cwd: plan.liveDir, agentDir: join(root, 'agent'), build: { dirty: false } };
  await Promise.all([plan.stageRoot, plan.liveDir, plan.stateDir, identity.agentDir].map(path => mkdir(path)));
  await mkdir(join(plan.liveDir, '.next/cache'), { recursive: true }); await writeFile(join(plan.liveDir, '.next/cache/live'), 'live');
  async function candidate(day, phase = 'complete') {
    const tag = `v2026.10.${day}`, stage = join(plan.stageRoot, tag), cache = join(stage, '.next/cache');
    await mkdir(cache, { recursive: true }); await writeFile(join(cache, 'webpack'), 'cache');
    await writeFile(join(stage, '.gitignore'), '.next/\n'); await writeFile(join(stage, 'package.json'), JSON.stringify({ version: tag.slice(1) }));
    const git = args => command('git', args, stage); git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
    const sha = git(['rev-parse', 'HEAD']);
    await writeFile(join(stage, '.next/required-server-files.json'), JSON.stringify({ config: { env: { PIWEB_BUILD_SHA: sha } } }));
    const receipt = { tag, phase, deployment: { status: 'done', identity: { ...identity, build: { sourceSha: sha, version: tag.slice(1), dirty: false } } },
      public: { origin: plan.publicOrigin, checkedAt: `2026-10-${day}T00:00:00Z`, checks: ['running-identity', 'session-list'] } };
    await writeFile(join(plan.stateDir, `${tag}.json`), JSON.stringify(receipt));
    return { tag, stage, cache };
  }
  return { root, plan, identity, candidate, options: { assertStopped: async () => {} } };
}
it('bounds completed cache history, preserves all executable files, failed candidates and live cache', async () => {
  const f = await fixture(), old = await f.candidate('01'), latest = await f.candidate('02'), failed = await f.candidate('03', 'public-check');
  const preview = await pruneCandidateCaches(f.plan, f.identity, { ...f.options, dryRun: true });
  expect(preview.removed).toEqual([`${old.tag}/.next/cache`]); await expect(access(old.cache)).resolves.toBeUndefined();
  const result = await pruneCandidateCaches(f.plan, f.identity, f.options);
  expect(result.kept).toEqual([latest.tag]); await expect(access(old.cache)).rejects.toThrow();
  await expect(access(join(old.stage, '.next/required-server-files.json'))).resolves.toBeUndefined();
  await expect(access(failed.cache)).resolves.toBeUndefined(); await expect(access(latest.cache)).resolves.toBeUndefined();
  expect(await readFile(join(f.plan.liveDir, '.next/cache/live'), 'utf8')).toBe('live');
  expect((await pruneCandidateCaches(f.plan, f.identity, f.options)).removed).toEqual([]);
});
it('keeps unknown, dirty, active and explicitly excluded candidates', async () => {
  const f = await fixture(); const unknown = await f.candidate('01'), dirty = await f.candidate('02'), active = await f.candidate('03'), excluded = await f.candidate('04');
  await rm(join(f.plan.stateDir, `${unknown.tag}.json`)); await writeFile(join(dirty.stage, 'package.json'), '{}');
  const result = await pruneCandidateCaches(f.plan, f.identity, { excludeTag: excluded.tag, assertStopped: async path => { if (path === active.stage) throw new Error('running'); } });
  expect(result.removed).toEqual([]);
  for (const item of [unknown, dirty, active, excluded]) await expect(access(item.cache)).resolves.toBeUndefined();
});
it('never follows cache symlinks and rejects overlap or symlink roots', async () => {
  const f = await fixture(), old = await f.candidate('01'); await f.candidate('02');
  await rm(old.cache, { recursive: true }); await symlink(join(f.plan.liveDir, '.next/cache'), old.cache);
  expect((await pruneCandidateCaches(f.plan, f.identity, f.options)).removed).toEqual([]);
  expect(await readFile(join(f.plan.liveDir, '.next/cache/live'), 'utf8')).toBe('live');
  await expect(pruneCandidateCaches({ ...f.plan, stageRoot: f.root }, f.identity, f.options)).rejects.toThrow('overlaps');
  const link = join(f.root, 'link'); await symlink(f.plan.stageRoot, link);
  await expect(pruneCandidateCaches({ ...f.plan, stageRoot: link }, f.identity, f.options)).rejects.toThrow('real directories');
});
