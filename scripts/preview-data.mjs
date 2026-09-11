import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const ISOLATED_AGENT_MARKER = '.piweb-isolated-agent.json';

function contains(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

// Check the nearest existing ancestor before creating anything. Resolving an
// alias after mkdir could already have written inside the real agent directory.
function canonicalDestination(target, allowSymlink = false, links = 0) {
  let current = target;
  const suffix = [];
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        if (!allowSymlink || links >= 40) throw new Error('Preview path must be a real directory, not a symlink.');
        // The protected production root may legitimately be relocated. Resolve
        // even dangling links so a new preview cannot occupy that destination.
        return join(canonicalDestination(resolve(dirname(current), readlinkSync(current)), true, links + 1), ...suffix);
      }
      if (!stat.isDirectory()) throw new Error('Preview path must be a real directory, not a symlink.');
      return join(realpathSync(current), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = resolve(current, '..');
      if (parent === current) throw error;
      suffix.unshift(relative(parent, current));
      current = parent;
    }
  }
}

function validateProvenance(markerPath, environment) {
  let fd;
  try {
    const info = lstatSync(markerPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4096) throw new Error('Invalid marker');
    fd = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 4096) throw new Error('Invalid marker');
    const marker = JSON.parse(readFileSync(fd, 'utf8'));
    if (marker?.schemaVersion !== 1 || marker?.kind !== 'pi-web-isolated-agent' || marker?.environment !== environment) throw new Error('Invalid marker');
  } catch {
    throw new Error('Invalid or mismatched isolated agent provenance marker. Refusing to use this data directory.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ensureProvenance(target, environment) {
  const markerPath = join(target, ISOLATED_AGENT_MARKER);
  const entries = readdirSync(target);
  if (!entries.includes(ISOLATED_AGENT_MARKER)) {
    if (entries.length) throw new Error('Nonempty agent directory has no isolated provenance marker. Refusing to import existing data.');
    const marker = { schemaVersion: 1, kind: 'pi-web-isolated-agent', environment };
    try {
      // Exclusive creation never follows or replaces a pre-existing marker.
      writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  validateProvenance(markerPath, environment);
}

export function prepareIsolatedAgentDir(environment, env, cwd, home) {
  if (environment !== 'preview' && environment !== 'fixture') return env.PI_CODING_AGENT_DIR;
  const defaultAgent = canonicalDestination(join(home, '.pi', 'agent'), true);
  const candidate = environment === 'fixture'
    ? env.PI_CODING_AGENT_DIR
    : (env.PIWEB_PREVIEW_DIR || join(cwd, '.pi-web-preview', 'agent'));
  if (!candidate || !isAbsolute(candidate)) throw new Error('Isolated agent directory must be an absolute path.');
  const target = canonicalDestination(resolve(candidate));
  if (contains(defaultAgent, target) || contains(target, defaultAgent)) throw new Error('Preview cannot share the real Pi agent directory.');
  if (environment === 'preview' && env.PI_CODING_AGENT_DIR && canonicalDestination(resolve(env.PI_CODING_AGENT_DIR)) !== target) {
    throw new Error('Unset PI_CODING_AGENT_DIR for preview; use PIWEB_PREVIEW_DIR for an independent directory.');
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  // Recheck canonical path after creation. Existing data is accepted only when
  // its provenance explicitly identifies this same isolated launch mode.
  if (realpathSync(target) !== target || lstatSync(target).isSymbolicLink()) throw new Error('Preview path changed while creating it.');
  ensureProvenance(target, environment);
  return target;
}
