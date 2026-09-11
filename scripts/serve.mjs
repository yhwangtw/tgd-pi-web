import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSupportedNodeVersion, NODE_SUPPORT_DESCRIPTION } from '../lib/node-support.mjs';
import { resolveServePlan, serveEnvironment } from './serve-plan.mjs';
import { prepareIsolatedAgentDir } from './preview-data.mjs';

try {
  if (!isSupportedNodeVersion(process.versions.node)) throw new Error(`Node ${NODE_SUPPORT_DESCRIPTION} required.`);
  const cwd = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const plan = resolveServePlan(process.argv[2], process.argv.slice(3), process.env);
  if (plan.environment === 'preview' || plan.environment === 'fixture') {
    const mode = plan.command === 'start' ? 'production' : 'development';
    if (['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`].some((name) => existsSync(join(cwd, name)))) {
      throw new Error('Isolated preview refuses automatic .env loading. Use a clean checkout without private .env files.');
    }
  }
  const agentDir = prepareIsolatedAgentDir(plan.environment, process.env, cwd, homedir());
  const markers = join(cwd, '.piweb-runtime');
  try { mkdirSync(markers, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (lstatSync(markers).isSymbolicLink() || !lstatSync(markers).isDirectory()) throw new Error('Invalid runtime marker directory.');
  const marker = join(markers, `${process.pid}.json`);
  const tempMarker = `${marker}.tmp`;
  let buildId = null;
  if (plan.command === 'start') buildId = readFileSync(join(cwd, '.next', 'BUILD_ID'), 'utf8').trim();
  const record = { pid: process.pid, childPid: null, cwd, startedAt: new Date().toISOString(), mode: plan.command, host: plan.host, port: plan.port, buildId };
  const persist = () => {
    writeFileSync(tempMarker, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(tempMarker, marker);
  };
  const cleanup = () => { for (const path of [marker, tempMarker]) { try { unlinkSync(path); } catch { /* Already removed. */ } } };
  persist();
  if (plan.remote) console.warn('Remote interface explicitly enabled. Configure the access gate or a trusted authenticated proxy before allowing clients.');
  console.info(`[pi-web] ${plan.environment} · http://${plan.host === '::1' ? '[::1]' : plan.host}:${plan.port}`);
  if (agentDir) console.info(`[pi-web] Agent data: ${agentDir}`);
  const child = spawn(process.execPath, [join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'), ...plan.args], {
    cwd, stdio: 'inherit', shell: false,
    env: serveEnvironment(plan, process.env, agentDir),
  });
  record.childPid = child.pid ?? null;
  persist();
  let stopping = false;
  const stop = (signal) => { if (!stopping) { stopping = true; child.kill(signal); } };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.once('error', (error) => { console.error(error.message); cleanup(); process.exitCode = 1; });
  child.once('exit', (code, signal) => { cleanup(); process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
} catch (error) {
  console.error(`[pi-web] ${error.message}`);
  process.exitCode = 1;
}
