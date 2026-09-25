import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main as releasePreflight } from './release.mjs';
import { checkCI, command, ghJson, isVersionOnlyCommit, releaseVersions, repositoryFromOrigin, requireSha, utcTag, validateTag } from './release-policy.mjs';
import { executeDeploymentCommand, runStagedDeployment, validateStagedPlan } from './staged-deployment.mjs';
import { assertCheckoutStopped } from './runtime-guard.mjs';
import { finishUpdateOperation, patchUpdateOperation, reserveUpdateOperation } from './update-operation-store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
const help = `Usage: bash scripts/release.sh [vYYYY.MM.DD[-N]] --deploy /absolute/plan.json [--execute]
Default: read-only preflight. --execute publishes, waits, stages, deploys and verifies.
Repeat the SAME tag and plan to resume. State stays outside source. A crashed lock
or uncertain cutover requires operator recovery; it is never cleared by a timer.`;

async function canonical(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}

export async function validatePipelinePlan(input, tag, sourceDir = root) {
  for (const name of ['stateDir', 'stageRoot', 'liveDir']) {
    if (!isAbsolute(input?.[name] || '')) throw new Error(`${name} must be an absolute path`);
  }
  const plan = { ...input, stateDir: await canonical(input.stateDir), stageRoot: await canonical(input.stageRoot), liveDir: await realpath(input.liveDir) };
  const paths = [plan.stateDir, plan.stageRoot, plan.liveDir, await realpath(sourceDir)];
  for (let i = 0; i < 2; i++) for (let j = i + 1; j < paths.length; j++) {
    if (inside(paths[i], paths[j]) || inside(paths[j], paths[i])) throw new Error('State and candidate roots must be separate from source, live and each other');
  }
  const url = new URL(plan.publicOrigin);
  if (url.protocol !== 'https:' || url.origin !== plan.publicOrigin || url.username || url.password) throw new Error('publicOrigin must be an exact HTTPS origin without credentials or a path');
  validateStagedPlan({ ...plan, stageDir: join(plan.stageRoot, tag), expected: { version: tag.slice(1), sourceSha: '0'.repeat(40) } });
  for (const argv of Object.values(plan.commands)) await access(argv[0], constants.X_OK);
  return plan;
}

async function readRecord(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Unsafe release state file');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeRecord(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}

async function withLock(directory, input, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Release state directory must be private (0700)');
  let operation;
  try { operation = await reserveUpdateOperation(directory, input); }
  catch (error) {
    if (error.code === 'UPDATE_OPERATION_CONFLICT') throw new Error('Release pipeline or managed update is active or interrupted. Inspect its processes and state before operator lock recovery');
    throw error;
  }
  try {
    await patchUpdateOperation(directory, operation.id, { status: 'running' });
    const result = await action(operation);
    await finishUpdateOperation(directory, operation.id, 'succeeded', 'Published release, local identity and public endpoint verified');
    return result;
  } catch (error) {
    if (error.requiresRecovery) await patchUpdateOperation(directory, operation.id, { status: 'interrupted', requiresRecovery: true,
      message: 'Cutover could not be verified; inspect the service and helpers before operator recovery' });
    else await finishUpdateOperation(directory, operation.id, 'failed', 'Pipeline stopped; inspect saved release progress before resuming');
    throw error;
  }
}

function optionalApi(endpoint) {
  try { return ghJson(endpoint); }
  catch (error) {
    if (/\(HTTP 404\)/.test(String(error.stderr))) return null;
    throw error;
  }
}

function safeIdentity(value) {
  return { pid: value.pid, startedAt: value.startedAt, cwd: value.cwd,
    environment: value.environment, agentDir: value.agentDir, build: value.build };
}

async function localIdentity(plan, env) {
  const response = await fetch(plan.liveIdentityUrl, {
    headers: env.PIWEB_UPDATE_HEALTH_COOKIE ? { Cookie: env.PIWEB_UPDATE_HEALTH_COOKIE } : {},
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Live identity is unavailable');
  return safeIdentity(await response.json());
}

export async function verifyPublicDeployment(plan, identity, env = process.env, request = fetch) {
  // Credentials are read at execution time, never stored in plan/state/logs.
  const headers = JSON.parse(env.PIWEB_RELEASE_PUBLIC_HEADERS_JSON || '{}');
  if (!headers || Array.isArray(headers) || typeof headers !== 'object'
    || Object.values(headers).some(value => typeof value !== 'string')) throw new Error('Invalid public request headers');
  async function read(path) {
    const response = await request(`${plan.publicOrigin}${path}`, {
      headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Public deployment check failed (authenticate the exact hostname before resuming)');
    return response.json();
  }
  const remote = await read('/api/runtime/identity');
  if (remote.build?.sourceSha !== identity.build.sourceSha || remote.build?.version !== identity.build.version
    || remote.build?.dirty !== false || remote.pid !== identity.pid || remote.startedAt !== identity.startedAt) {
    throw new Error('Public hostname is not serving the verified local build');
  }
  const sessions = await read('/api/sessions');
  if (!Array.isArray(sessions.sessions)) throw new Error('Public session-list smoke check failed');
  // Session content and cookies are intentionally never returned or persisted.
  return { origin: plan.publicOrigin, checkedAt: new Date().toISOString(), checks: ['running-identity', 'session-list'] };
}

export function selectReleaseRun(runs, state, workflowId) {
  const matching = runs.filter(run => run.workflow_id === workflowId && run.event === 'workflow_dispatch'
    && run.head_branch === 'main' && run.display_title === `Release ${state.tag}`
    && run.repository?.full_name?.toLowerCase() === state.repository.toLowerCase()
    && run.head_repository?.full_name?.toLowerCase() === state.repository.toLowerCase()
    && Date.parse(run.created_at) >= Date.parse(state.createdAt) - 2000);
  matching.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id);
  return matching[0] || null;
}

async function requireIsolatedCandidate(directory) {
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local', '.env.test', '.env.test.local']) {
    try { await lstat(join(directory, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Candidate contains environment files; keep staging isolated from private runtime configuration');
  }
}

export function githubReleaseClient(sourceDir = root) {
  const git = args => command('git', args, sourceDir);
  return {
    preflight(tag) {
      const evidence = releasePreflight([tag], { run: (exe, args) => command(exe, args, sourceDir), log: () => {} });
      return { repository: repositoryFromOrigin(git(['remote', 'get-url', 'origin'])), sourceSha: requireSha(git(['rev-parse', 'HEAD'])), ciSha: evidence.sha };
    },
    checkCI: state => checkCI(state.repository, state.ciSha),
    release: state => optionalApi(`repos/${state.repository}/releases/tags/${state.tag}`),
    dispatch(state) {
      command('gh', ['workflow', 'run', 'release.yml', '--repo', state.repository, '--ref', 'main',
        '-f', `tag=${state.tag}`, '-f', `expected_sha=${state.sourceSha}`], sourceDir);
    },
    run(state) {
      const prefix = `repos/${state.repository}/actions`;
      const workflow = ghJson(`${prefix}/workflows/release.yml`);
      if (!Number.isSafeInteger(workflow.id) || workflow.path !== '.github/workflows/release.yml') throw new Error('Canonical release workflow is unavailable');
      // A recovery dispatch can run from a later main while resuming the same
      // immutable tag. prepare() separately proves the tag's exact source and
      // version-only parent; a workflow head SHA is not that tag's provenance.
      const runs = ghJson(`${prefix}/workflows/${workflow.id}/runs?event=workflow_dispatch&per_page=100`, { paginate: true }).flatMap(page => page.workflow_runs);
      return selectReleaseRun(runs, state, workflow.id);
    },
    remoteTag(state) {
      const prefix = `repos/${state.repository}/git`;
      const ref = ghJson(`${prefix}/ref/tags/${state.tag}`);
      if (ref.object?.type !== 'tag') throw new Error('Expected an annotated release tag');
      const tag = ghJson(`${prefix}/tags/${requireSha(ref.object.sha)}`);
      if (tag.tag !== state.tag || tag.object?.type !== 'commit') throw new Error('Unexpected release tag target');
      return requireSha(tag.object.sha);
    },
    async prepare(state, plan, target) {
      const stageDir = join(plan.stageRoot, state.tag);
      await mkdir(stageDir, { recursive: true });
      if (await realpath(stageDir) !== stageDir) throw new Error('Candidate path changed');
      await assertCheckoutStopped(stageDir);
      await requireIsolatedCandidate(stageDir);
      const stageGit = args => command('git', args, stageDir);
      const remote = `https://github.com/${state.repository}.git`;
      try { await access(join(stageDir, '.git')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // git init never discards files; dirty candidates are refused below.
        stageGit(['init', '--quiet']);
        stageGit(['remote', 'add', 'origin', remote]);
      }
      if (stageGit(['rev-parse', '--show-toplevel']) !== stageDir || stageGit(['remote', 'get-url', 'origin']) !== remote
        || stageGit(['status', '--porcelain'])) throw new Error('Candidate is dirty or belongs to another repository');
      stageGit(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main', `refs/tags/${state.tag}:refs/tags/${state.tag}`]);
      if (stageGit(['rev-parse', `refs/tags/${state.tag}^{commit}`]) !== target) throw new Error('Release tag changed while preparing candidate');
      stageGit(['merge-base', '--is-ancestor', target, 'origin/main']);
      const versions = releaseVersions(stageGit, target);
      const parents = stageGit(['show', '-s', '--format=%P', target]).split(' ');
      if (versions.version !== state.tag.slice(1) || (target !== state.sourceSha
        && (parents.length !== 1 || parents[0] !== state.sourceSha || !isVersionOnlyCommit(stageGit, target, state.sourceSha)))) {
        throw new Error('Published source does not match the pinned release request');
      }
      stageGit(['checkout', '--detach', target]);
      await requireIsolatedCandidate(stageDir);
      return stageDir;
    },
  };
}

export async function runReleasePipeline(input, options = {}, dependencies = {}) {
  const tag = validateTag(options.tag || utcTag(), { existing: true });
  const plan = await validatePipelinePlan(input, tag, options.sourceDir || root);
  const statePath = join(plan.stateDir, `${tag}.json`);
  const planHash = digest(plan);
  const client = dependencies.client || githubReleaseClient(options.sourceDir);
  const log = dependencies.log || console.log;
  const wait = dependencies.wait || delay;
  const env = options.env || process.env;
  if (env.PIWEB_UPDATE_OPERATION_DIR && await canonical(env.PIWEB_UPDATE_OPERATION_DIR) !== plan.stateDir) {
    throw new Error('stateDir must match PIWEB_UPDATE_OPERATION_DIR so all service updates share one lock');
  }
  let state = await readRecord(statePath);
  function validateState() {
    if (state && (state.schema !== 1 || state.tag !== tag || state.planHash !== planHash
      || !/^[a-f0-9]{40}$/.test(state.sourceSha || '') || !/^[a-f0-9]{40}$/.test(state.ciSha || ''))) {
      throw new Error('Release state or plan changed; inspect it before resuming');
    }
  }
  validateState();
  const initial = state ? null : client.preflight(tag);
  if (!state) validateTag(tag); // New requests use today's UTC date; resume keeps its original tag.
  if (!state && client.release({ ...initial, tag })) throw new Error('Tag is already published; use its existing receipt or choose a new UTC sequence tag');
  if (!Number.isSafeInteger(options.pollAttempts ?? 180) || (options.pollAttempts ?? 180) < 1 || (options.pollAttempts ?? 180) > 180) {
    throw new Error('Publication wait must use between 1 and 180 attempts');
  }
  if (!options.execute) {
    if (state) client.checkCI(state);
    log(`Preflight passed for ${tag}. ${state ? `Resume from ${state.phase}.` : 'New release.'} Add --execute to publish and deploy. State: ${statePath}`);
    return { status: 'preflight', statePath };
  }
  return withLock(plan.stateDir, { action: 'update', cwd: plan.liveDir, expected: { version: tag.slice(1) } }, async operation => {
    state = await readRecord(statePath);
    validateState();
    if (!state && !initial) throw new Error('Release state disappeared; inspect it before resuming');
    const resuming = Boolean(state);
    if (!state) state = { schema: 1, tag, planHash, ...initial, phase: 'release', createdAt: new Date().toISOString() };
    state.operationId = operation.id;
    const save = async () => { state.updatedAt = new Date().toISOString(); await writeRecord(statePath, state); };
    await save();
    if (resuming) client.checkCI(state); // New preflight already checked CI; resume only reads existing evidence.
    let release = client.release(state);
    if (!release && !state.dispatch) {
      state.dispatch = 'requested'; // Persist BEFORE dispatch: an uncertain request is not repeated.
      await save();
      client.dispatch(state);
    }
    if (!state.release) {
      const attempts = options.pollAttempts ?? 180;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const run = client.run(state);
        if (run?.status === 'completed' && run.conclusion !== 'success') throw new Error('Release workflow failed; fix/re-run that workflow, then resume this tag');
        release = client.release(state);
        if (release && run?.status === 'completed' && run.conclusion === 'success') break;
        if (attempt + 1 === attempts) throw new Error('Release is pending or its dispatch is uncertain. Resume this tag; no duplicate request was sent');
        if (attempt % 6 === 0) log(`Waiting for ${tag} publication; completed steps are saved.`);
        await wait(5000);
      }
    }
    if (!release || release.draft || release.tag_name !== tag || !release.published_at) throw new Error('Expected published GitHub Release is unavailable');
    const target = client.remoteTag(state);
    if (state.release && state.release.sha !== target) throw new Error('Published release tag moved; refusing to resume');
    const expected = { version: tag.slice(1), sourceSha: target };
    await patchUpdateOperation(plan.stateDir, operation.id, { expected });
    const readLive = () => (dependencies.localIdentity || localIdentity)(plan, env);
    if (state.deployment?.status === 'running' || state.deployment?.status === 'recovery') {
      throw new Error('Previous cutover is uncertain; inspect service and helper processes before operator recovery');
    }
    let identity;
    if (state.deployment?.status === 'done') {
      identity = await readLive();
      const prior = state.deployment.identity;
      if (identity.build?.sourceSha !== target || identity.build?.version !== expected.version || identity.build?.dirty !== false
        || await realpath(identity.cwd) !== plan.liveDir || identity.environment !== prior.environment || identity.agentDir !== prior.agentDir) {
        throw new Error('Live service changed since deployment; refusing automatic redeployment');
      }
      log('Verified the completed deployment; resuming public checks only.');
    } else {
      if (state.deployment?.before) {
        const current = await readLive();
        const before = state.deployment.before;
        if (current.build?.sourceSha !== before.build.sourceSha || current.build?.version !== before.build.version
          || current.build?.dirty !== false || await realpath(current.cwd) !== plan.liveDir
          || current.environment !== before.environment || current.agentDir !== before.agentDir) {
          throw new Error('Live service changed after the failed attempt; inspect it before retrying deployment');
        }
      }
      log(`Preparing exact release ${tag} in its isolated candidate directory.`);
      const baseline = await readLive();
      await patchUpdateOperation(plan.stateDir, operation.id, { before: baseline });
      const stageDir = await client.prepare(state, plan, target);
      state.release = { sha: target, url: release.html_url };
      state.phase = 'deploy';
      state.deployment = { status: 'running', before: baseline };
      await save();
      let cutoverStarted = false;
      try {
        const result = await (dependencies.deploy || runStagedDeployment)({ ...plan, stageDir, expected },
          { ...env, PIWEB_UPDATE_OPERATION_ROOT: plan.stateDir, PIWEB_UPDATE_OPERATION_ID: operation.id }, {
          checkpoint: { fingerprint: state.buildFingerprint, save: async value => { state.buildFingerprint = value; await save(); } },
          execute: async (phase, argv, cwd, phaseEnv) => {
            if (phase === 'stop') cutoverStarted = true;
            state.deployment.step = phase;
            await save();
            log(`Deployment: ${phase}`);
            return (dependencies.execute || executeDeploymentCommand)(phase, argv, cwd, phaseEnv);
          },
        });
        identity = safeIdentity(result.identity);
        state.deployment = { status: 'done', identity };
        state.phase = 'public-check';
        await save();
      } catch (error) {
        state.deployment.status = !cutoverStarted || error.rollbackVerified ? 'retryable' : 'recovery';
        await save();
        if (state.deployment.status === 'recovery') error.requiresRecovery = true;
        throw error;
      }
    }
    state.public = await (dependencies.verifyPublic || verifyPublicDeployment)(plan, identity, env);
    state.phase = 'complete';
    await save();
    log(`Published and deployed ${tag}: ${state.release.url}\nVerified ${plan.publicOrigin}; state: ${statePath}`);
    return { status: 'succeeded', statePath, state };
  });
}

export async function pipelineMain(argv) {
  const args = [...argv];
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(help); return; }
  const index = args.indexOf('--deploy');
  if (index < 0 || !isAbsolute(args[index + 1] || '')) throw new Error(help);
  const path = args[index + 1];
  args.splice(index, 2);
  const execute = args.includes('--execute');
  if (execute) args.splice(args.indexOf('--execute'), 1);
  if (args.length > 1 || args.some(arg => arg.startsWith('-'))) throw new Error(help);
  const plan = JSON.parse(await readFile(path, 'utf8'));
  return runReleasePipeline(plan, { tag: args[0], execute });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  pipelineMain(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
