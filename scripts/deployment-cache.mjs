import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { command } from './release-policy.mjs';
import { assertCheckoutStopped } from './runtime-guard.mjs';
import { isVerifiedRelease } from './release-retention.mjs';

const tagPattern = /^v\d{4}\.\d{2}\.\d{2}(?:-[1-9]\d*)?$/;
const inside = (parent, child) => { const p = relative(parent, child); return p === '' || (p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p)); };
async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Cache paths must be real directories');
}
async function json(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Unsafe cache provenance record');
  return JSON.parse(await readFile(path, 'utf8'));
}
export function validateCandidateCache(value) {
  if (value !== undefined && (!value || value.keep !== 1 || Object.keys(value).some(key => key !== 'keep'))) {
    throw new Error('candidateCache must be { keep: 1 }');
  }
}

/** Call under the service update lock. Only regenerable cache from verified,
 * stopped, clean candidates is managed. No artifacts or recovery data are removed. */
export async function pruneCandidateCaches(plan, identity, { excludeTag, dryRun = false, assertStopped = assertCheckoutStopped } = {}) {
  validateCandidateCache(plan.candidateCache);
  if (!plan.candidateCache) return { status: 'not-configured' };
  const root = resolve(plan.stageRoot);
  try { await directory(root); } catch (error) { if (error.code === 'ENOENT') return { status: 'complete', kept: [], removed: [], skipped: [] }; throw error; }
  for (const path of [plan.liveDir, plan.stateDir, plan.retention?.backupRoot, identity.agentDir].filter(Boolean)) {
    const protectedPath = await realpath(path).catch(() => resolve(path));
    if (inside(root, protectedPath) || inside(protectedPath, root)) throw new Error('Cache root overlaps protected service data');
  }
  if (identity.cwd !== plan.liveDir || !identity.agentDir || identity.build?.dirty !== false) throw new Error('Cache cleanup requires a verified live identity');
  const candidates = [], skipped = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !tagPattern.test(entry.name) || entry.name === excludeTag) continue;
    const stage = join(root, entry.name), cache = join(stage, '.next/cache');
    try {
      await directory(stage); await directory(join(stage, '.next')); await directory(cache);
      const receipt = await json(join(plan.stateDir, `${entry.name}.json`));
      const build = await json(join(stage, '.next/required-server-files.json'));
      if (!isVerifiedRelease(receipt, plan) || receipt.tag !== entry.name || receipt.deployment.identity.agentDir !== identity.agentDir
        || build.config?.env?.PIWEB_BUILD_SHA !== receipt.deployment.identity.build.sourceSha
        || (await json(join(stage, 'package.json'))).version !== entry.name.slice(1)
        || command('git', ['rev-parse', 'HEAD'], stage) !== receipt.deployment.identity.build.sourceSha
        || command('git', ['status', '--porcelain'], stage)) throw new Error('Unverified or changed candidate');
      await assertStopped(stage);
      candidates.push({ tag: entry.name, stage, cache, checkedAt: Date.parse(receipt.public.checkedAt) });
    } catch (error) { if (error.code !== 'ENOENT') skipped.push(entry.name); }
  }
  candidates.sort((a, b) => b.checkedAt - a.checkedAt || b.tag.localeCompare(a.tag));
  const kept = candidates.slice(0, 1).map(item => item.tag), removed = [];
  for (const item of candidates.slice(1)) {
    // Recheck ownership immediately before removal; never follow a replaced link.
    await directory(item.stage); await directory(join(item.stage, '.next')); await directory(item.cache);
    await assertStopped(item.stage);
    if (!dryRun) await rm(item.cache, { recursive: true });
    removed.push(`${item.tag}/.next/cache`);
  }
  return { status: dryRun ? 'preview' : 'complete', kept, removed, skipped };
}
