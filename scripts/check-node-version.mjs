import { isSupportedNodeVersion, NODE_SUPPORT_DESCRIPTION } from '../lib/node-support.mjs';

const version = process.argv[2] ?? process.versions.node;
if (!isSupportedNodeVersion(version)) {
  console.error(`Unsupported Node.js ${version}; requires ${NODE_SUPPORT_DESCRIPTION}.`);
  process.exitCode = 1;
}
