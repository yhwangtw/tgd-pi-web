import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { command, ghJson, repositoryFromOrigin, requireSha, utcTag, validateTag } from './release-policy.mjs';
import { main as preflight } from './release.mjs';
import { runReleasePipeline, validatePipelinePlan } from './release-pipeline.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const help = `Usage: bash scripts/release.sh [vYYYY.MM.DD[-N]] [--dispatch]
       bash scripts/release.sh [vYYYY.MM.DD[-N]] --deploy /absolute/plan.json [--execute]
Preflight automatically prepares an isolated remote-main checkout and the next UTC tag.
Your current checkout is untouched. --dispatch requests publication; --execute also deploys.
An unfinished deployment with the same plan resumes its saved tag. No local build is run.`;

export function parseArgs(argv) {
  const args = [...argv];
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  let planPath;
  const index = args.indexOf('--deploy');
  if (index >= 0) {
    if (!isAbsolute(args[index + 1] || '')) throw new Error(help);
    planPath = args[index + 1]; args.splice(index, 2);
  }
  const flag = planPath ? '--execute' : '--dispatch';
  const execute = args.includes(flag);
  if (execute) args.splice(args.indexOf(flag), 1);
  if (args.length > 1 || args.some(arg => arg.startsWith('-'))) throw new Error(help);
  return { tag: args[0], planPath, execute };
}

export function nextTag(tags, now = new Date()) {
  const date = utcTag(now);
  let sequence = -1;
  for (const tag of tags) {
    if (tag === date) sequence = Math.max(sequence, 0);
    else if (tag.startsWith(`${date}-`) && /^[1-9]\d*$/.test(tag.slice(date.length + 1))) {
      const value = Number(tag.slice(date.length + 1));
      if (!Number.isSafeInteger(value)) throw new Error('Release sequence is too large');
      sequence = Math.max(sequence, value);
    }
  }
  return validateTag(sequence < 0 ? date : `${date}-${sequence + 1}`, { now });
}

/** Only a freshly-created disposable directory is ever written or removed. */
export function prepareCheckout(remote, target, { parent = tmpdir() } = {}) {
  requireSha(target);
  const directory = realpathSync(mkdtempSync(join(parent, 'pi-release-preflight-')));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  const git = args => command('git', args, directory);
  try {
    git(['init', '--quiet', '--template=']);
    git(['config', 'core.hooksPath', '/dev/null']);
    git(['remote', 'add', 'origin', remote]);
    git(['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
    if (git(['rev-parse', 'origin/main']) !== target) throw new Error('Remote main changed during preparation; retry preflight');
    git(['checkout', '--quiet', '--detach', target]);
    return { directory, cleanup };
  } catch (error) { cleanup(); throw error; }
}

function readReceipt(path) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Unsafe release receipt');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function pendingTag(plan, repository) {
  const hash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  let files;
  try { files = readdirSync(plan.stateDir); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const pending = files.filter(name => /^v\d{4}\.\d{2}\.\d{2}(?:-[1-9]\d*)?\.json$/.test(name))
    .map(name => readReceipt(join(plan.stateDir, name)))
    .filter(state => state?.schema === 1 && state.repository === repository && state.planHash === hash && state.phase !== 'complete');
  if (pending.length > 1) throw new Error('Multiple unfinished releases; specify the saved tag to resume');
  return pending[0]?.tag;
}

export async function main(argv, { sourceDir = root, api = ghJson, now = new Date(), log = console.log,
  prepare = prepareCheckout, check = preflight, pipeline = runReleasePipeline } = {}) {
  const args = parseArgs(argv);
  if (args.help) { log(help); return; }
  const remote = command('git', ['remote', 'get-url', 'origin'], sourceDir);
  const repository = repositoryFromOrigin(remote);
  const input = args.planPath ? JSON.parse(readFileSync(args.planPath, 'utf8')) : undefined;
  const plan = input ? await validatePipelinePlan(input, utcTag(now), sourceDir) : undefined;
  let tag = args.tag ? validateTag(args.tag, { now, existing: !!plan }) : plan ? pendingTag(plan, repository) : undefined;
  const receipt = plan && tag ? readReceipt(join(plan.stateDir, `${validateTag(tag, { now, existing: true })}.json`)) : null;
  if (receipt) {
    if (receipt.repository !== repository) throw new Error('Release receipt belongs to another repository');
    log(`Resuming ${tag} from saved progress.`);
    return pipeline(plan, { tag, execute: args.execute, sourceDir });
  }
  const refs = api(`repos/${repository}/git/matching-refs/tags/${utcTag(now)}`, { paginate: true }).flat();
  const tags = refs.map(ref => ref.ref.replace(/^refs\/tags\//, ''));
  tag = tag ? validateTag(tag, { now }) : nextTag(tags, now);
  if (tags.includes(tag)) throw new Error('Tag already exists; use its saved deployment receipt or choose a new tag');
  const target = requireSha(api(`repos/${repository}/commits/main`).sha);
  const checkout = prepare(remote, target);
  try {
    log(`Prepared remote main ${target}; ${tag}. Caller checkout unchanged.`);
    if (plan) return await pipeline(plan, { tag, execute: args.execute, sourceDir: checkout.directory });
    return check([tag, ...(args.execute ? ['--dispatch'] : [])], {
      run: (exe, params) => command(exe, params, checkout.directory), api, now, log,
    });
  } finally { checkout.cleanup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`Release stopped: ${error.message}`); process.exitCode = 1; });
}
