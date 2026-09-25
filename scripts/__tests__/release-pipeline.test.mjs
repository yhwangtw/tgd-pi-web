import { access, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReleasePipeline, selectReleaseRun, validatePipelinePlan, verifyPublicDeployment } from '../release-pipeline.mjs';
import { utcTag } from '../release-policy.mjs';
import { runStagedDeployment } from '../staged-deployment.mjs';

const roots = [];
afterEach(async () => { vi.useRealTimers(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-release-pipeline-')));
  roots.push(root);
  const sourceDir = join(root, 'source');
  const liveDir = join(root, 'live');
  await mkdir(sourceDir); await mkdir(liveDir);
  const tag = utcTag();
  const target = 'b'.repeat(40);
  const plan = { stateDir: join(root, 'state'), stageRoot: join(root, 'candidates'), liveDir,
    publicOrigin: 'https://pi.example.test', stageIdentityUrl: 'http://127.0.0.1:30178/api/runtime/identity', liveIdentityUrl: 'http://127.0.0.1:30141/api/runtime/identity',
    commands: Object.fromEntries(['build', 'stageStart', 'stageStop', 'stop', 'switch', 'start', 'rollback'].map(phase => [phase, [process.execPath, phase]])) };
  const identity = { pid: 1234, startedAt: new Date().toISOString(), cwd: liveDir, environment: 'production', agentDir: '/private/fixture-agent', build: { version: tag.slice(1), sourceSha: target, dirty: false } };
  let published = false;
  const client = {
    preflight: vi.fn(() => ({ repository: 'owner/project', sourceSha: 'a'.repeat(40), ciSha: 'a'.repeat(40) })),
    checkCI: vi.fn(),
    release: vi.fn(() => published ? { tag_name: tag, draft: false, published_at: new Date().toISOString(), html_url: 'https://github.com/owner/project/releases/tag/' + tag } : null),
    dispatch: vi.fn(() => { published = true; }),
    run: vi.fn(() => ({ status: 'completed', conclusion: 'success' })),
    remoteTag: vi.fn(() => target),
    prepare: vi.fn(async () => { const dir = join(plan.stageRoot, tag); await mkdir(dir, { recursive: true }); return dir; }),
  };
  const deploy = vi.fn(async (staged, env, hooks) => {
    await hooks.execute('build', staged.commands.build, staged.stageDir, env);
    await hooks.checkpoint.save('verified-artifact-hash');
    await hooks.execute('stop', staged.commands.stop, liveDir, env);
    return { status: 'succeeded', identity };
  });
  const dependencies = { client, deploy, execute: vi.fn(), localIdentity: vi.fn(async () => identity),
    verifyPublic: vi.fn(async () => ({ origin: plan.publicOrigin, checks: ['running-identity', 'session-list'] })), wait: vi.fn(), log: vi.fn() };
  const options = { tag, sourceDir, execute: true, pollAttempts: 2, env: { NODE_ENV: 'test', PIWEB_RELEASE_PUBLIC_HEADERS_JSON: '{"Cookie":"private-fixture-cookie"}' } };
  const run = changes => runReleasePipeline(plan, { ...options, ...changes }, dependencies);
  const readState = async () => JSON.parse(await readFile(join(plan.stateDir, `${tag}.json`), 'utf8'));
  return { root, plan, options, dependencies, client, identity, target, tag, run, readState };
}

describe('resumable release and deployment', () => {
  it('preflights without creating state, dispatching or running adapters', async () => {
    const f = await fixture();
    expect((await f.run({ execute: false })).status).toBe('preflight');
    await expect(access(f.plan.stateDir)).rejects.toThrow();
    expect(f.client.dispatch).not.toHaveBeenCalled();
    expect(f.dependencies.deploy).not.toHaveBeenCalled();
  });
  it('publishes once, prepares the exact tag, deploys and verifies the public origin', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.status).toBe('succeeded');
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dependencies.deploy.mock.calls[0][0].expected).toEqual({ version: f.tag.slice(1), sourceSha: f.target });
    expect((await f.readState()).phase).toBe('complete');
    expect((await stat(result.statePath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await f.readState())).not.toContain('private-fixture-cookie');
  });
  it('connects the real staging orchestrator to the shared managed-operation record', async () => {
    const f = await fixture();
    const previous = { ...f.identity, pid: 100, startedAt: '2000-01-01T00:00:00Z', build: { version: '2026.01.01', sourceSha: 'c'.repeat(40), dirty: false } };
    let startedLive = false;
    f.dependencies.localIdentity.mockResolvedValue(previous);
    f.dependencies.execute.mockImplementation(async phase => { if (phase === 'start') startedLive = true; });
    f.dependencies.deploy = (plan, env, hooks) => runStagedDeployment(plan, env, {
      ...hooks, assertCheckoutStopped: vi.fn(), attempts: 1, fingerprint: async () => 'fixture-build-hash',
      readIdentity: async (_url, environment) => environment.PIWEB_ENVIRONMENT === 'fixture'
        ? { ...f.identity, cwd: plan.stageDir, environment: 'fixture', agentDir: environment.PI_CODING_AGENT_DIR }
        : startedLive ? f.identity : previous,
    });
    expect((await f.run()).status).toBe('succeeded');
    expect(f.dependencies.execute.mock.calls.map(([phase]) => phase)).toEqual(['build', 'stageStart', 'stageStop', 'stop', 'switch', 'start']);
    await expect(access(join(f.plan.stateDir, 'active.lock'))).rejects.toThrow();
  });
  it('rejects a fresh receipt for an already published tag and rejects invalid wait limits', async () => {
    const f = await fixture();
    f.client.release.mockReturnValue({ tag_name: f.tag });
    await expect(f.run()).rejects.toThrow('already published');
    expect(f.client.dispatch).not.toHaveBeenCalled();
    f.client.release.mockReturnValue(null);
    await expect(f.run({ pollAttempts: 0 })).rejects.toThrow('wait');
  });
  it('resumes public verification without publishing, preparing or deploying again', async () => {
    const f = await fixture();
    f.dependencies.verifyPublic.mockRejectedValueOnce(new Error('access login required'));
    await expect(f.run()).rejects.toThrow('access login');
    expect((await f.readState()).phase).toBe('public-check');
    await f.run();
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
    expect(f.client.prepare).toHaveBeenCalledTimes(1);
    expect(f.dependencies.deploy).toHaveBeenCalledTimes(1);
    expect(f.client.checkCI).toHaveBeenCalledTimes(1);
    expect(f.dependencies.localIdentity).toHaveBeenCalledTimes(2);
  });
  it('does not duplicate a timed-out publication request', async () => {
    const f = await fixture();
    f.client.run.mockReturnValueOnce(null).mockReturnValueOnce(null);
    await expect(f.run()).rejects.toThrow('pending');
    await f.run();
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
  });
  it('records dispatch intent before a network error with an uncertain outcome', async () => {
    const f = await fixture();
    const dispatch = f.client.dispatch.getMockImplementation();
    f.client.dispatch.mockImplementationOnce(() => { dispatch(); throw new Error('connection lost'); });
    await expect(f.run()).rejects.toThrow('connection lost');
    await f.run();
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
  });
  it('does not deploy when the publication workflow failed or the release is a draft', async () => {
    const f = await fixture();
    f.client.run.mockReturnValue({ status: 'completed', conclusion: 'failure' });
    await expect(f.run()).rejects.toThrow('workflow failed');
    expect(f.client.prepare).not.toHaveBeenCalled();
    f.client.run.mockReturnValue({ status: 'completed', conclusion: 'success' });
    f.client.release.mockReturnValue({ tag_name: f.tag, draft: true });
    await expect(f.run()).rejects.toThrow('published');
    expect(f.dependencies.deploy).not.toHaveBeenCalled();
  });
  it('keeps the original UTC tag when resuming on another day', async () => {
    const f = await fixture();
    await f.run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 86_400_000);
    await f.run();
    expect(f.client.preflight).toHaveBeenCalledTimes(1);
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
  });
  it('rejects changed plans and moved release tags before any repeated deployment', async () => {
    const f = await fixture();
    await f.run();
    await expect(runReleasePipeline({ ...f.plan, publicOrigin: 'https://wrong.example.test' }, f.options, f.dependencies)).rejects.toThrow('plan changed');
    f.client.remoteTag.mockReturnValue('d'.repeat(40));
    await expect(f.run()).rejects.toThrow('tag moved');
    expect(f.dependencies.deploy).toHaveBeenCalledTimes(1);
  });
  it('refuses to overwrite a service that changed after a successful deployment', async () => {
    const f = await fixture();
    await f.run();
    f.dependencies.localIdentity.mockResolvedValue({ ...f.identity, build: { ...f.identity.build, sourceSha: 'd'.repeat(40) } });
    await expect(f.run()).rejects.toThrow('Live service changed');
    expect(f.dependencies.deploy).toHaveBeenCalledTimes(1);
  });
  it('can retry a verified rollback while preserving the validated build checkpoint', async () => {
    const f = await fixture();
    f.dependencies.deploy.mockImplementationOnce(async (plan, env, hooks) => {
      await hooks.checkpoint.save('verified-before-failure');
      await hooks.execute('stop', plan.commands.stop, plan.liveDir, env);
      throw Object.assign(new Error('restored previous release'), { rollbackVerified: true });
    });
    await expect(f.run()).rejects.toThrow('restored');
    expect((await f.readState()).deployment.status).toBe('retryable');
    await f.run();
    expect(f.dependencies.deploy.mock.calls[1][2].checkpoint.fingerprint).toBe('verified-before-failure');
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
  });
  it('blocks an uncertain cutover instead of automatically repeating destructive steps', async () => {
    const f = await fixture();
    f.dependencies.deploy.mockImplementationOnce(async (plan, env, hooks) => {
      await hooks.execute('stop', plan.commands.stop, plan.liveDir, env);
      throw new Error('rollback could not be verified');
    });
    await expect(f.run()).rejects.toThrow('rollback');
    await expect(f.run()).rejects.toThrow('operator lock recovery');
    expect(f.dependencies.deploy).toHaveBeenCalledTimes(1);
  });
  it('refuses a concurrent or abandoned lock and never clears it by age', async () => {
    const f = await fixture();
    await mkdir(join(f.plan.stateDir, 'active.lock'), { recursive: true, mode: 0o700 });
    await expect(f.run()).rejects.toThrow('operator lock recovery');
    await expect(access(join(f.plan.stateDir, 'active.lock'))).resolves.toBeUndefined();
    expect(f.client.dispatch).not.toHaveBeenCalled();
  });
  it('requires external non-overlapping state, stage and live paths plus an exact public origin', async () => {
    const f = await fixture();
    await expect(validatePipelinePlan({ ...f.plan, stageRoot: join(f.plan.liveDir, 'candidate') }, f.tag, f.options.sourceDir)).rejects.toThrow('separate');
    await expect(validatePipelinePlan({ ...f.plan, publicOrigin: 'https://pi.example.test/path' }, f.tag, f.options.sourceDir)).rejects.toThrow('origin');
    await expect(f.run({ env: { PIWEB_UPDATE_OPERATION_DIR: join(f.root, 'different-store') } })).rejects.toThrow('share one lock');
  });
  it('routes the existing shell entrypoint to strict pipeline argument validation', () => {
    const result = spawnSync('bash', [resolve('scripts/release.sh'), '--deploy', 'relative-plan.json'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: bash scripts/release.sh');
  });
});

describe('public deployment readback', () => {
  it('checks the exact origin, running identity and sessions without retaining private content', async () => {
    const f = await fixture();
    const request = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => f.identity })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessions: [{ privateText: 'do not persist' }] }) });
    const receipt = await verifyPublicDeployment(f.plan, f.identity, f.options.env, request);
    expect(request.mock.calls.map(([url]) => url)).toEqual(['https://pi.example.test/api/runtime/identity', 'https://pi.example.test/api/sessions']);
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Cookie: 'private-fixture-cookie' } });
    expect(JSON.stringify(receipt)).not.toMatch(/private|persist/);
  });
  it('does not accept an Access page, wrong running build, or invalid sessions payload', async () => {
    const f = await fixture();
    await expect(verifyPublicDeployment(f.plan, f.identity, {}, vi.fn(async () => ({ ok: false })))).rejects.toThrow('authenticate');
    await expect(verifyPublicDeployment(f.plan, f.identity, {}, vi.fn(async () => ({ ok: true, json: async () => ({ ...f.identity, pid: 9999 }) })))).rejects.toThrow('not serving');
    const request = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => f.identity })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ error: 'not sessions' }) });
    await expect(verifyPublicDeployment(f.plan, f.identity, {}, request)).rejects.toThrow('session-list');
  });
});

it('binds publication to its canonical workflow/tag and accepts recovery from later main without hiding a newer failure', () => {
  const state = { repository: 'owner/project', tag: 'v2026.09.25', sourceSha: 'a'.repeat(40), createdAt: '2026-09-25T00:00:00Z' };
  const good = { id: 1, workflow_id: 10, event: 'workflow_dispatch', head_branch: 'main', head_sha: state.sourceSha,
    display_title: 'Release v2026.09.25', repository: { full_name: state.repository }, head_repository: { full_name: state.repository },
    created_at: state.createdAt, updated_at: state.createdAt, status: 'completed', conclusion: 'success' };
  const recovery = { ...good, id: 2, head_sha: 'b'.repeat(40), updated_at: '2026-09-25T01:00:00Z' };
  expect(selectReleaseRun([good, recovery], state, 10)).toBe(recovery);
  const failed = { ...recovery, id: 3, conclusion: 'failure', updated_at: '2026-09-25T02:00:00Z' };
  expect(selectReleaseRun([good, recovery, failed], state, 10)).toBe(failed);
  for (const change of [{ workflow_id: 11 }, { event: 'push' }, { head_branch: 'unreviewed' },
    { display_title: 'Release v2026.09.25-1' }, { head_repository: { full_name: 'fork/project' } }]) {
    expect(selectReleaseRun([{ ...good, ...change }], state, 10)).toBeNull();
  }
});
