import { lstat, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const sha = /^[a-f0-9]{40,64}$/;
const tagPattern = /^v\d{4}\.\d{2}\.\d{2}(?:-[1-9]\d*)?$/;
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
async function directory(path) {
  try { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function availableDirectory(path) {
  try { return (await stat(path)).isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function record(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return null;
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
function verified(receipt, plan) {
  return receipt?.phase === 'complete' && receipt.deployment?.status === 'done'
    && tagPattern.test(receipt.tag) && sha.test(receipt.deployment.identity?.build?.sourceSha || '')
    && receipt.deployment.identity.build.version === receipt.tag.slice(1)
    && receipt.deployment.identity.build.dirty === false
    && receipt.deployment.identity.cwd === plan.liveDir
    && receipt.public?.origin === plan.publicOrigin
    && Number.isFinite(Date.parse(receipt.public.checkedAt))
    && ['running-identity', 'session-list'].every(check => receipt.public.checks?.includes(check));
}

/** Only the deployment adapter's successful build/module backups are managed.
 * Keep logs/manifests, unknown or incomplete attempts, and all symlinks intact. */
export async function retainPreviousRelease(plan, identity, current, { dryRun = false } = {}) {
  if (!plan.retention) return { status: 'not-configured' };
  if (plan.retention.keepPrevious !== 1 || !isAbsolute(plan.retention.backupRoot || '')) {
    throw new Error('Retention requires an absolute backupRoot and keepPrevious: 1');
  }
  const root = resolve(plan.retention.backupRoot);
  if (!await directory(root) || await realpath(root) !== root) throw new Error('Retention root must be a real directory without symlink parents');
  for (const path of [plan.liveDir, plan.stageRoot, plan.stateDir, identity.agentDir].filter(Boolean)) {
    const protectedPath = await realpath(path).catch(() => resolve(path));
    if (inside(root, protectedPath) || inside(protectedPath, root)) throw new Error('Retention root overlaps protected service data');
  }
  if (!verified(current, plan) || identity.build?.dirty !== false || identity.cwd !== plan.liveDir
    || identity.build?.sourceSha !== current.deployment.identity.build.sourceSha
    || identity.build?.version !== current.tag.slice(1)
    || identity.agentDir !== current.deployment.identity.agentDir) throw new Error('Retention requires the verified currently running release');
  const kept = `deploy-${current.tag}-${identity.build.sourceSha.slice(0, 8)}`;
  const keepPath = join(root, kept);
  const manifest = await record(join(keepPath, 'operator.json'));
  const previousBuild = await record(join(keepPath, 'previous-build/required-server-files.json'));
  const previousNext = await record(join(keepPath, 'previous-node_modules/next/package.json'));
  if (!await directory(keepPath) || !sha.test(manifest?.previousSha || '')
    || manifest?.targetSha !== identity.build.sourceSha
    || previousBuild?.config?.env?.PIWEB_BUILD_SHA !== manifest.previousSha || previousNext?.name !== 'next'
    || !await availableDirectory(join(keepPath, 'previous-build')) || !await availableDirectory(join(keepPath, 'previous-node_modules'))
    || !(await readFile(join(keepPath, 'previous-build/BUILD_ID'), 'utf8').catch(() => '')).trim()) {
    throw new Error('The previous release is not recoverable; no old builds were removed');
  }
  const protectedArtifacts = (await Promise.all([
    join(keepPath, 'previous-build'), join(keepPath, 'previous-node_modules'),
    join(plan.liveDir, '.next'), join(plan.liveDir, 'node_modules'),
  ].map(path => realpath(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; })))).filter(Boolean);
  const removed = [], skipped = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === kept) continue;
    const match = /^(deploy-(v\d{4}\.\d{2}\.\d{2}(?:-[1-9]\d*)?))-([a-f0-9]{8})$/.exec(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !match) { skipped.push(entry.name); continue; }
    const path = join(root, entry.name);
    const receipt = await record(join(plan.stateDir, `${match[2]}.json`));
    const old = await record(join(path, 'operator.json'));
    if (!verified(receipt, plan) || receipt.tag !== match[2]
      || receipt.deployment.identity.agentDir !== identity.agentDir
      || Date.parse(receipt.public.checkedAt) >= Date.parse(current.public.checkedAt)
      || !sha.test(old?.previousSha || '') || old?.targetSha !== receipt.deployment.identity.build.sourceSha
      || old.targetSha.slice(0, 8) !== match[3]) { skipped.push(entry.name); continue; }
    // Never remove a top-level symlink or an entire directory of recovery evidence.
    for (const name of ['previous-build', 'previous-node_modules']) {
      const artifact = join(path, name);
      if (!await directory(artifact) || await realpath(artifact) !== artifact) continue;
      if (protectedArtifacts.some(path => inside(artifact, path) || inside(path, artifact))) {
        skipped.push(`${entry.name}/${name}`); continue;
      }
      if (!dryRun) await rm(artifact, { recursive: true });
      removed.push(`${entry.name}/${name}`);
    }
  }
  return { status: dryRun ? 'preview' : 'complete', kept, removed, skipped };
}
