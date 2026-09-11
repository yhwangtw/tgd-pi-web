// One contract for setup, launchers and the Update Center. Keep this module
// dependency-free so it can run before npm install on an unsupported Node.
export const NODE_SUPPORT_RANGE = '^22.19.0 || >=23.4.0';
export const NODE_SUPPORT_DESCRIPTION = '22.19+ (22.x) or 23.4+ (including 24 and newer)';

/** @param {unknown} version */
export function isSupportedNodeVersion(version) {
  if (typeof version !== 'string') return false;
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const [major, minor] = parts;
  return major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 19);
}
