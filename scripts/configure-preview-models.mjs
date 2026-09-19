import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareIsolatedAgentDir } from './preview-data.mjs';

const DEFAULT_KEYS = ['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'enabledModels', 'compaction'];
const readObject = (file) => {
  if (!existsSync(file)) return {};
  if (lstatSync(file).size > 4 * 1024 * 1024) throw new Error('Configuration is too large');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a configuration object');
  return value;
};

/** Explicit opt-in only. Never invoked by automated preview or fixture startup. */
export function configurePreviewModels({ source, cwd, home, env = {} }) {
  const sourceDir = realpathSync(source);
  const models = readObject(join(sourceDir, 'models.json'));
  const settings = readObject(join(sourceDir, 'settings.json'));
  const authPath = realpathSync(join(sourceDir, 'auth.json'));
  readObject(authPath);
  const target = prepareIsolatedAgentDir('preview', env, cwd, home);
  if (sourceDir === target) throw new Error('Source must be separate from preview');
  const targetSettings = join(target, 'settings.json');
  const mergedSettings = readObject(targetSettings);
  for (const key of DEFAULT_KEYS) {
    if (key in settings) mergedSettings[key] = settings[key];
    else delete mergedSettings[key];
  }
  // Preserve existing private configuration for recovery; do not copy sessions,
  // schedules, packages, extensions, hooks or arbitrary files from the source.
  const backup = join(target, `.model-config-backup-${Date.now()}`);
  mkdirSync(backup, { mode: 0o700 });
  for (const name of ['models.json', 'settings.json', 'auth.json']) {
    const destination = join(target, name);
    if (existsSync(destination)) copyFileSync(destination, join(backup, name), constants.COPYFILE_EXCL);
  }
  for (const [name, value] of [['models.json', models], ['settings.json', mergedSettings]]) {
    const temporary = join(backup, `next-${name}`);
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(target, name));
  }
  const authLink = join(backup, 'next-auth.json');
  symlinkSync(authPath, authLink);
  renameSync(authLink, join(target, 'auth.json'));
  return { target, backup, modelProviders: Object.keys(models.providers ?? {}), defaultProvider: mergedSettings.defaultProvider, defaultModel: mergedSettings.defaultModel };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--source')) throw new Error('Usage: npm run preview:configure -- [--source /path/to/agent]');
    const cwd = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
    const result = configurePreviewModels({ source: args[1] ?? join(homedir(), '.pi', 'agent'), cwd, home: homedir(), env: process.env });
    console.log(JSON.stringify({ ...result, sharedLogin: true, sessionsCopied: false, schedulesCopied: false }));
  } catch { console.error('Preview configuration failed. Check the source JSON files and directory permissions. No credential values are printed.'); process.exitCode = 1; }
}
