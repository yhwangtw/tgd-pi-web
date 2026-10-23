import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const manifest = 'piweb-e2e-build.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function filesDigest(root, files) {
  const digest = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    const path = join(root, file), info = lstatSync(path);
    digest.update(JSON.stringify([file, info.mode & 0o777, info.isSymbolicLink()]));
    digest.update(info.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
    digest.update('\0');
  }
  return digest.digest('hex');
}
function buildFiles(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (name === 'cache' || name === manifest || name === 'trace') return [];
    return entry.isDirectory() ? buildFiles(root, name) : [name];
  });
}
function snapshot(root, env) {
  const buildRoot = join(root, '.next');
  const buildId = readFileSync(join(buildRoot, 'BUILD_ID'), 'utf8').trim();
  if (!buildId) throw new Error('E2E requires a completed production build');
  const sourceFiles = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const buildEnv = Object.fromEntries(Object.keys(env).sort()
    .filter(key => /^(?:NEXT_PUBLIC_|PIWEB_BUILD_)/.test(key)
      || ['CI', 'NODE_ENV', 'NODE_OPTIONS', 'PIWEB_ENVIRONMENT', 'ANALYZE'].includes(key))
    .map(key => [key, env[key]]));
  return { schema: 1, sourceSha: git(root, ['rev-parse', 'HEAD']), source: filesDigest(root, sourceFiles),
    platform: process.platform, arch: process.arch, node: process.version, environment: hash(JSON.stringify(buildEnv)),
    buildId, build: filesDigest(buildRoot, buildFiles(buildRoot)) };
}

export function recordE2EBuild(root = process.cwd(), env = process.env) {
  const value = snapshot(root, env);
  writeFileSync(join(root, '.next', manifest), `${JSON.stringify(value)}\n`);
  return value;
}
export function verifyE2EBuild(root = process.cwd(), env = process.env) {
  const saved = JSON.parse(readFileSync(join(root, '.next', manifest), 'utf8'));
  const actual = snapshot(root, env);
  if (JSON.stringify(saved) !== JSON.stringify(actual)) {
    // Report only known field names, never source bytes or environment values.
    // Keep the full comparison above so extra/reordered metadata still fails.
    const fields = Object.keys(actual).filter(field => saved?.[field] !== actual[field]);
    throw new Error(`E2E build does not match this source, Node/platform, environment or artifact; differing fields: ${fields.join(', ') || 'manifest metadata'}; rebuild instead of reusing it`);
  }
  return saved;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'record') recordE2EBuild();
  else if (process.argv[2] === 'verify') verifyE2EBuild();
  else throw new Error('Usage: node scripts/e2e-build.mjs record|verify');
}
