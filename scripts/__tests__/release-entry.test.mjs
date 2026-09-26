import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validatePipelinePlan } from '../release-pipeline.mjs';
import { command } from '../release-policy.mjs';
import { main, nextTag, parseArgs, pendingTag, prepareCheckout } from '../release-entry.mjs';

const roots = [];
const now = new Date('2026-09-26T01:00:00Z');
function temp() { const path = mkdtempSync(join(tmpdir(), 'pi-release-entry-test-')); roots.push(path); return path; }
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function repository() {
  const root = temp();
  const git = args => command('git', args, root);
  git(['init', '-b', 'main', '--template=']);
  git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, 'source.txt'), 'reviewed');
  git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Reviewed']);
  return { root, git, sha: git(['rev-parse', 'HEAD']) };
}

describe('automatic release preparation', () => {
  it('selects the next UTC sequence from all tags, including unpublished tags', () => {
    expect(nextTag([], now)).toBe('v2026.09.26');
    expect(nextTag(['v2026.09.26', 'v2026.09.26-9', 'v2026.09.25-50'], now)).toBe('v2026.09.26-10');
  });
  it('fetches reviewed main in isolation while preserving caller files, index, branch, and private notes', () => {
    const repo = repository();
    repo.git(['checkout', '-b', 'feature']);
    writeFileSync(join(repo.root, 'source.txt'), 'local edit'); repo.git(['add', 'source.txt']);
    writeFileSync(join(repo.root, 'private-note.txt'), 'keep');
    const before = repo.git(['status', '--porcelain']);
    const parent = temp();
    const prepared = prepareCheckout(repo.root, repo.sha, { parent });
    expect(command('git', ['rev-parse', 'HEAD'], prepared.directory)).toBe(repo.sha);
    expect(command('git', ['status', '--porcelain'], prepared.directory)).toBe('');
    expect(readFileSync(join(prepared.directory, 'source.txt'), 'utf8')).toBe('reviewed');
    expect(repo.git(['status', '--porcelain'])).toBe(before);
    expect(repo.git(['branch', '--show-current'])).toBe('feature');
    expect(readFileSync(join(repo.root, 'private-note.txt'), 'utf8')).toBe('keep');
    prepared.cleanup(); expect(existsSync(prepared.directory)).toBe(false);
    expect(existsSync(repo.root)).toBe(true);
  });
  it('cleans only its temporary checkout and fails before dispatch when remote main moved', () => {
    const repo = repository(), parent = temp();
    expect(() => prepareCheckout(repo.root, 'a'.repeat(40), { parent })).toThrow('main changed');
    expect(readdirSync(parent)).toEqual([]);
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(repo.sha);
  });
  it('preflights and dispatches only in the prepared checkout, cleaning it on errors', async () => {
    const repo = repository(); repo.git(['remote', 'add', 'origin', 'https://github.com/owner/project.git']);
    const cleanup = vi.fn();
    const prepare = vi.fn(() => ({ directory: repo.root, cleanup }));
    const api = vi.fn(endpoint => endpoint.includes('matching-refs') ? [[{ ref: 'refs/tags/v2026.09.26' }]] : { sha: repo.sha });
    const check = vi.fn(() => { throw new Error('CI failed'); });
    await expect(main(['--dispatch'], { sourceDir: repo.root, now, api, prepare, check, log: vi.fn() })).rejects.toThrow('CI failed');
    expect(check.mock.calls[0][0]).toEqual(['v2026.09.26-1', '--dispatch']);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith('https://github.com/owner/project.git', repo.sha);
  });
  it('does not prepare or dispatch an already existing tag', async () => {
    const repo = repository(); repo.git(['remote', 'add', 'origin', 'https://github.com/owner/project.git']);
    const prepare = vi.fn();
    await expect(main(['v2026.09.26', '--dispatch'], { sourceDir: repo.root, now,
      api: () => [[{ ref: 'refs/tags/v2026.09.26' }]], prepare })).rejects.toThrow('already exists');
    expect(prepare).not.toHaveBeenCalled();
  });
  it('resumes a matching unfinished receipt without silently choosing a fresh tag', () => {
    const stateDir = temp();
    const plan = { stateDir, liveDir: '/fixture' };
    const receipt = { schema: 1, tag: 'v2026.09.25', repository: 'owner/project', phase: 'stage', planHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
    writeFileSync(join(stateDir, `${receipt.tag}.json`), JSON.stringify(receipt));
    expect(pendingTag(plan, 'owner/project')).toBe(receipt.tag);
    expect(pendingTag(plan, 'another/project')).toBeUndefined();
    writeFileSync(join(stateDir, 'v2026.09.26.json'), JSON.stringify({ ...receipt, tag: 'v2026.09.26' }));
    expect(() => pendingTag(plan, 'owner/project')).toThrow('Multiple');
  });
  it('resumes an older matching deployment without fetching main or requesting a new publication', async () => {
    const repo = repository(); repo.git(['remote', 'add', 'origin', 'https://github.com/owner/project.git']);
    const input = { stateDir: temp(), stageRoot: temp(), liveDir: temp(),
      stageIdentityUrl: 'http://127.0.0.1:30178/api/runtime/identity', liveIdentityUrl: 'http://127.0.0.1:30141/api/runtime/identity', publicOrigin: 'https://pi.example.com',
      commands: Object.fromEntries(['build', 'stageStart', 'stageStop', 'stop', 'switch', 'start', 'rollback'].map(name => [name, [process.execPath, 'fixture.mjs']])) };
    const plan = await validatePipelinePlan(input, 'v2026.09.26', repo.root);
    const receipt = { schema: 1, tag: 'v2026.09.25', repository: 'owner/project', phase: 'stage', planHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
    writeFileSync(join(input.stateDir, 'v2026.09.25.json'), JSON.stringify(receipt));
    const path = join(temp(), 'plan.json'); writeFileSync(path, JSON.stringify(input));
    const api = vi.fn(), prepare = vi.fn(), pipeline = vi.fn(async () => 'resumed');
    await expect(main(['--deploy', path, '--execute'], { sourceDir: repo.root, now, api, prepare, pipeline, log: vi.fn() })).resolves.toBe('resumed');
    expect(api).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(pipeline).toHaveBeenCalledWith(plan, { tag: 'v2026.09.25', execute: true, sourceDir: repo.root });
  });
  it('validates modes before network access and keeps help side effect free', async () => {
    const api = vi.fn(); await main(['--help'], { api, log: vi.fn() });
    expect(api).not.toHaveBeenCalled();
    for (const args of [['--execute'], ['--dispatch', '--dispatch'], ['--deploy', 'relative.json'], ['--deploy', '/plan.json', '--dispatch']]) expect(() => parseArgs(args)).toThrow('Usage');
  });
});
