import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
/** Never hide an old archive or silently change engines when starting the SDK app. */
export function assertSessionArchiveConverted(agentDir) {
  if (!agentDir) return;
  for (const name of ['durable-sessions', 'durable-runs']) {
  const path = join(agentDir, name);
  if (!existsSync(path)) continue;
  if (readdirSync(path).some(name => /^[a-f0-9-]{36}$/i.test(name))) {
    throw new Error('This agent directory contains retired Pi Durable archives. Stop the old service, run scripts/convert-session-archive.mjs into a new agent directory, then select that directory. Original archives are preserved; startup does not convert or resume them.');
  }
  }
}
