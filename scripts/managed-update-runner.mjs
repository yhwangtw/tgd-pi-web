import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finishUpdateOperation, patchUpdateOperation, readExpectedUpdateIdentity, readUpdateOperation } from './update-operation-store.mjs';

export function validateIdentityUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/api/runtime/identity' || url.search || url.hash) {
    throw new Error('Update health must use a loopback /api/runtime/identity URL without credentials');
  }
  return url.href;
}

export function matchesRunningIdentity(identity, expected, before) {
  return Boolean(identity && identity.build && Number.isSafeInteger(identity.pid)
    && identity.pid !== before.pid && typeof identity.startedAt === 'string'
    && Date.parse(identity.startedAt) > Date.parse(before.startedAt)
    && typeof expected.version === 'string' && expected.version !== 'unknown'
    && /^[a-f0-9]{40,64}$/.test(expected.sourceSha || '')
    && identity.build.version === expected.version && identity.build.sourceSha === expected.sourceSha
    && identity.build.dirty === false
    && (!before.environment || identity.environment === before.environment)
    && (!before.agentDir || identity.agentDir === before.agentDir));
}

async function runCommand(command, cwd, env, onPid) {
  return new Promise((resolveResult, reject) => {
    let pidWrite = Promise.resolve();
    let pidWriteError;
    const child = spawn(command.executable, command.args, { cwd, env, shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { pidWrite = onPid(child.pid).catch(error => { pidWriteError = error; }); });
    // Never release a lock while an already-spawned helper may still mutate.
    child.once('exit', (code, signal) => { void pidWrite.then(() => pidWriteError ? reject(pidWriteError) : resolveResult({ code, signal })); });
  });
}

/** Detached from Next: results survive the service process being replaced. */
export async function runManagedOperation(root, id, env, dependencies = {}) {
  const command = JSON.parse(env.PIWEB_MANAGED_OPERATION_COMMAND || 'null');
  if (!command || typeof command.executable !== 'string' || !Array.isArray(command.args)) throw new Error('Missing managed command');
  const operation = await readUpdateOperation(root, id);
  if (operation.status !== 'reserved') throw new Error('Update operation has already started');
  await patchUpdateOperation(root, id, { status: 'running', pid: process.pid });
  try {
    const execute = dependencies.execute || runCommand;
    const result = await execute(command, operation.cwd, env, pid => patchUpdateOperation(root, id, { helperPid: pid }));
    if (result.code !== 0) {
      const latest = await readUpdateOperation(root, id);
      return await finishUpdateOperation(root, id, 'failed', latest.rollbackVerified
        ? 'Update failed; the previous running build was restored and verified'
        : 'Managed helper did not complete successfully', { helperPid: null, exitCode: result.code, signal: result.signal });
    }
    await patchUpdateOperation(root, id, { status: 'verifying', helperPid: null, exitCode: 0 });
    const published = await readExpectedUpdateIdentity(root, id);
    const expected = published || operation.expected;
    if (operation.expected?.version && expected.version !== operation.expected.version) {
      return await finishUpdateOperation(root, id, 'verification_failed', 'Helper target version did not match the approved update');
    }
    if (operation.expected?.sourceSha && expected.sourceSha !== operation.expected.sourceSha) {
      return await finishUpdateOperation(root, id, 'verification_failed', 'Helper target source SHA did not match the approved update');
    }
    if (!/^[a-f0-9]{40,64}$/.test(expected.sourceSha || '')) {
      return await finishUpdateOperation(root, id, 'verification_failed', 'Helper did not provide the exact staged build SHA');
    }
    const url = validateIdentityUrl(env.PIWEB_UPDATE_HEALTH_URL);
    const fetchIdentity = dependencies.fetchIdentity || (async () => {
      const response = await fetch(url, {
        headers: env.PIWEB_UPDATE_HEALTH_COOKIE ? { Cookie: env.PIWEB_UPDATE_HEALTH_COOKIE } : {},
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Running identity is not healthy');
      return response.json();
    });
    const wait = dependencies.wait || (milliseconds => new Promise(done => setTimeout(done, milliseconds)));
    const attempts = Math.max(1, Math.min(150, Number(env.PIWEB_UPDATE_VERIFY_ATTEMPTS) || 60));
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const identity = await fetchIdentity();
        if (matchesRunningIdentity(identity, expected, operation.before)
          && typeof identity.cwd === 'string' && await realpath(identity.cwd) === await realpath(operation.cwd)) {
          return await finishUpdateOperation(root, id, 'succeeded', 'The new running process and exact build identity were verified', {
            verified: { pid: identity.pid, startedAt: identity.startedAt, build: identity.build },
          });
        }
      } catch { /* A restart can temporarily disconnect; do not claim success. */ }
      if (attempt + 1 < attempts) await wait(2000);
    }
    return await finishUpdateOperation(root, id, 'verification_failed', 'Helper exited, but a new healthy process with the approved build was not verified');
  } catch {
    return await finishUpdateOperation(root, id, 'failed', 'Managed update supervisor could not complete the operation');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runManagedOperation(process.env.PIWEB_UPDATE_OPERATION_ROOT, process.env.PIWEB_UPDATE_OPERATION_ID, process.env)
    .catch(() => { process.exitCode = 1; });
}
