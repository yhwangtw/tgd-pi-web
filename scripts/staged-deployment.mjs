import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCheckoutStopped } from './runtime-guard.mjs';
import { serveEnvironment } from './serve-plan.mjs';
import { matchesRunningIdentity, validateIdentityUrl } from './managed-update-runner.mjs';
import { patchUpdateOperation, readUpdateOperation, writeExpectedUpdateIdentity } from './update-operation-store.mjs';

const PHASES = ['build', 'stageStart', 'stageStop', 'stop', 'switch', 'start', 'rollback'];
const nested = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };

export function validateStagedPlan(plan) {
  if (!plan || !isAbsolute(plan.stageDir || '') || !isAbsolute(plan.liveDir || '')
    || nested(resolve(plan.liveDir), resolve(plan.stageDir)) || nested(resolve(plan.stageDir), resolve(plan.liveDir))) {
    throw new Error('Stage and live directories must be explicit, separate, non-nested paths');
  }
  if (!/^\d{4}\.\d{2}\.\d{2}(?:-[1-9]\d*)?$/.test(plan.expected?.version || '')
    || !/^[a-f0-9]{40,64}$/.test(plan.expected?.sourceSha || '')) throw new Error('An exact approved version and source SHA are required');
  const stageUrl = validateIdentityUrl(plan.stageIdentityUrl);
  const liveUrl = validateIdentityUrl(plan.liveIdentityUrl);
  if (new URL(stageUrl).port === new URL(liveUrl).port) throw new Error('Stage and live health checks must use different ports');
  for (const phase of PHASES) {
    const argv = plan.commands?.[phase];
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 32 || !isAbsolute(argv[0])
      || argv.some(item => typeof item !== 'string' || item.includes('\0') || item.length > 4096)) {
      throw new Error(`Explicit shell-free ${phase} adapter argv is required`);
    }
  }
  return plan;
}

async function execute(_phase, argv, cwd, env) {
  await new Promise((done, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new Error(`Deployment adapter ${_phase} failed`)));
  });
}

async function readIdentity(url, env) {
  const response = await fetch(url, {
    headers: env.PIWEB_UPDATE_HEALTH_COOKIE ? { Cookie: env.PIWEB_UPDATE_HEALTH_COOKIE } : {},
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Deployment identity endpoint is not healthy');
  return response.json();
}

async function waitForIdentity(url, expected, before, cwd, env, read, wait, attempts) {
  for (let index = 0; index < attempts; index++) {
    try {
      const identity = await read(url, env);
      const identityCwd = typeof identity.cwd === 'string' ? await realpath(identity.cwd) : null;
      const buildMatches = identity.build?.version === expected.version && identity.build?.sourceSha === expected.sourceSha && identity.build?.dirty === false;
      const isolated = before || (identity.environment === 'fixture' && identity.agentDir === env.PI_CODING_AGENT_DIR);
      if (isolated && identityCwd === cwd && buildMatches && (!before || matchesRunningIdentity(identity, expected, before))) return identity;
    } catch { /* Bounded retry while the operator's service adapter starts. */ }
    if (index + 1 < attempts) await wait(1000);
  }
  throw new Error('Expected healthy running build was not verified');
}

/**
 * This orchestrates operator-owned adapters; it never invents a launchd label,
 * rewrites a service file, or resets a live checkout. No adapter => no action.
 */
export async function runStagedDeployment(input, env = process.env, dependencies = {}) {
  const plan = validateStagedPlan(input);
  const stageDir = await realpath(plan.stageDir);
  const liveDir = await realpath(plan.liveDir);
  if (nested(stageDir, liveDir) || nested(liveDir, stageDir)) throw new Error('Canonical stage and live directories overlap');
  const exec = dependencies.execute || execute;
  const read = dependencies.readIdentity || readIdentity;
  const wait = dependencies.wait || (milliseconds => new Promise(done => setTimeout(done, milliseconds)));
  const attempts = dependencies.attempts || 60;
  const stopped = dependencies.assertCheckoutStopped || assertCheckoutStopped;
  await stopped(stageDir);
  const fixtureDir = await mkdtemp(join(tmpdir(), 'pi-staged-health-'));
  const stageUrl = new URL(plan.stageIdentityUrl);
  // Candidate commands get the same allowlisted environment as fixture
  // previews, never the live provider keys, NODE_OPTIONS, or update adapters.
  // Derive binding from the already validated loopback health endpoint too.
  const stageEnv = {
    ...serveEnvironment({ environment: 'fixture', host: stageUrl.hostname.replace(/^\[|\]$/g, ''), port: Number(stageUrl.port || 80) }, env, fixtureDir),
    PIWEB_ACCESS_PASSWORD: '', PIWEB_SESSION_SECRET: '', PIWEB_UPDATE_HEALTH_COOKIE: '',
  };
  const commonEnv = { ...env, PIWEB_STAGED_SOURCE_DIR: stageDir, PIWEB_LIVE_SOURCE_DIR: liveDir };
  const step = (phase, stage = false) => exec(phase, plan.commands[phase], stage ? stageDir : liveDir, { ...(stage ? stageEnv : commonEnv), PIWEB_DEPLOY_PHASE: phase });
  let stageStarted = false;
  try {
    await step('build', true);
    stageStarted = true; // Even a partially failing start must run stageStop.
    await step('stageStart', true);
    await waitForIdentity(plan.stageIdentityUrl, plan.expected, null, stageDir, stageEnv, read, wait, attempts);
  } finally {
    if (stageStarted) {
      try { await step('stageStop', true); await stopped(stageDir); }
      catch { throw new Error(`Stage stop failed; live deployment was untouched. Preserve and inspect the isolated agent directory: ${fixtureDir}`); }
    }
    await rm(fixtureDir, { recursive: true, force: true });
  }
  // A successful build alone never authorizes a cutover: capture the current
  // process/build for rollback and verify candidate identity before touching it.
  const before = await read(plan.liveIdentityUrl, env);
  if (!before?.build?.sourceSha || before.build.dirty !== false || typeof before.cwd !== 'string'
    || await realpath(before.cwd) !== liveDir) throw new Error('Current running build cannot be verified for rollback');
  if (env.PIWEB_UPDATE_OPERATION_ROOT && env.PIWEB_UPDATE_OPERATION_ID) {
    const operation = await readUpdateOperation(env.PIWEB_UPDATE_OPERATION_ROOT, env.PIWEB_UPDATE_OPERATION_ID);
    if (operation.expected?.version && operation.expected.version !== plan.expected.version) throw new Error('Stage version differs from the approved operation');
    if (operation.expected?.sourceSha && operation.expected.sourceSha !== plan.expected.sourceSha) throw new Error('Stage source SHA differs from the approved operation');
    if (operation.before?.pid !== before.pid || operation.before?.startedAt !== before.startedAt
      || operation.before?.build?.sourceSha !== before.build.sourceSha) throw new Error('Running service changed after update approval; prepare a new operation');
    await writeExpectedUpdateIdentity(env.PIWEB_UPDATE_OPERATION_ROOT, env.PIWEB_UPDATE_OPERATION_ID, plan.expected);
  }
  try {
    await step('stop');
    await stopped(liveDir);
    await step('switch');
    await step('start');
    return { status: 'succeeded', identity: await waitForIdentity(plan.liveIdentityUrl, plan.expected, before, liveDir, env, read, wait, attempts) };
  } catch {
    try {
      await step('stop');
      await stopped(liveDir);
      await step('rollback');
      await step('start');
      const restored = await waitForIdentity(plan.liveIdentityUrl, before.build, before, liveDir, env, read, wait, attempts);
      if (env.PIWEB_UPDATE_OPERATION_ROOT && env.PIWEB_UPDATE_OPERATION_ID) {
        await patchUpdateOperation(env.PIWEB_UPDATE_OPERATION_ROOT, env.PIWEB_UPDATE_OPERATION_ID, { rollbackVerified: true, rollbackBuild: restored.build });
      }
      throw Object.assign(new Error('Cutover failed; the previous build was restored and verified'), { rollbackVerified: true });
    } catch (error) {
      if (error.rollbackVerified) throw error;
      throw new Error('Cutover and rollback verification failed; operator recovery is required');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error('Provide an operator-owned staged deployment plan JSON');
    await runStagedDeployment(JSON.parse(await readFile(process.argv[2], 'utf8')));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Staged deployment failed');
    process.exitCode = 1;
  }
}
