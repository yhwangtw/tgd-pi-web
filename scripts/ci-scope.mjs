import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPRCI, command, ghJson, repositoryName, requireSha } from './release-policy.mjs';

export function classifyChanges(files, { manual = false, unknown = false } = {}) {
  if (manual || unknown || !files.length) return 'compatibility';
  const docs = file => /^(?:README(?:\.[\w-]+)?\.md|AGENTS\.md|LICENSE(?:\.md)?|docs\/.*\.(?:md|png|jpe?g|svg|webp))$/.test(file);
  if (files.every(docs)) return 'docs';
  return files.some(file => /^(?:package(?:-lock)?\.json|\.github\/workflows\/|scripts\/(?:ci-|check-node|node-support|runtime-|serve\.|setup-|patch-pi|release-|staged-|update-|managed-)|setup\.sh|serve\.json|lib\/(?:node-|runtime-|agent-runtime))/.test(file))
    ? 'compatibility' : 'normal';
}

export function matrices(profile) {
  return {
    runtime: { include: profile === 'compatibility'
      ? ['ubuntu-latest', 'macos-latest'].flatMap(os => ['22.19.0', '23.4.0', '24', '26'].map(node => ({ os, node })))
      : [{ os: 'ubuntu-latest', node: '22.19.0' }, { os: 'macos-latest', node: '26' }] },
    install: profile === 'compatibility' ? ['ubuntu-latest', 'macos-latest'] : ['ubuntu-latest'],
  };
}

export function verifyReuse(repository, sha, api = ghJson) {
  repositoryName(repository); requireSha(sha);
  const workflow = api(`repos/${repository}/actions/workflows/ci.yml`);
  if (!Number.isSafeInteger(workflow.id) || workflow.path !== '.github/workflows/ci.yml') throw new Error('Invalid CI workflow');
  return checkPRCI(repository, sha, workflow.id, api);
}

export function changedFiles(event, eventName, git = args => command('git', args)) {
  const head = requireSha(event.pull_request?.head?.sha || event.after);
  const base = requireSha(event.pull_request?.base?.sha || event.before);
  if (/^0+$/.test(base)) throw new Error('Missing base commit');
  const range = eventName === 'pull_request' ? `${base}...${head}` : `${base}..${head}`;
  // Include both paths of a rename so moving executable code into docs is not docs-only.
  return { range, files: git(['diff', '--name-only', '--no-renames', '-z', range]).split('\0').filter(Boolean) };
}

export function main(argv = [], env = process.env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (argv[0] === '--verify-reuse') {
    if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Reuse requires merged main');
    const evidence = verifyReuse(env.GITHUB_REPOSITORY, env.GITHUB_SHA);
    console.log(`Verified PR #${evidence.number}, matching source tree: ${evidence.url}`);
    return;
  }
  let diff;
  try { diff = changedFiles(event, env.GITHUB_EVENT_NAME); } catch { /* Full checks on missing history. */ }
  if (argv[0] === '--check-docs') {
    if (!diff || classifyChanges(diff.files) !== 'docs') throw new Error('Not a documentation-only change');
    command('git', ['diff', '--check', diff.range]);
    return;
  }
  const profile = classifyChanges(diff?.files || [], { manual: env.GITHUB_EVENT_NAME === 'workflow_dispatch', unknown: !diff });
  let reuse = false;
  if (profile !== 'docs' && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main') {
    try { verifyReuse(env.GITHUB_REPOSITORY, env.GITHUB_SHA); reuse = true; }
    catch (error) { console.log(`Running checks on main: ${error.message}`); }
  }
  const outputs = { profile, reuse, ...matrices(profile) };
  for (const [key, value] of Object.entries(outputs)) appendFileSync(env.GITHUB_OUTPUT, `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}\n`);
  console.log(`CI coverage: ${profile}${reuse ? ' (verified PR reuse)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
