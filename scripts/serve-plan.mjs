const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function serveEnvironment(plan, env, agentDir) {
  const isolated = plan.environment === 'preview' || plan.environment === 'fixture';
  const base = isolated
    ? Object.fromEntries(Object.entries(env).filter(([key]) => /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|LANG|LC_[A-Z_]+|SystemRoot|COMSPEC|PATHEXT)$/i.test(key)))
    : { ...env };
  return { ...base, PIWEB_ENVIRONMENT: plan.environment, PIWEB_HOST: plan.host, PORT: String(plan.port),
    ...(isolated ? { NEXT_TELEMETRY_DISABLED: '1' } : {}),
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}) };
}

/** Build a shell-free, explicit host/port contract for all supported launch modes. */
export function resolveServePlan(mode, args = [], env = {}) {
  if (!['dev', 'start', 'preview'].includes(mode)) throw new Error('Use dev, start, or preview.');
  let host = env.PIWEB_HOST || '127.0.0.1';
  let port = env.PORT || (mode === 'preview' ? '30142' : '30141');
  const forwarded = [];
  let hostSeen = false;
  let portSeen = false;
  for (let i = 0; i < args.length; i++) {
    const [key, inline] = args[i].split(/=([\s\S]*)/);
    if (['--hostname', '-H', '--port', '-p'].includes(key)) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${key}`);
      if (key === '--hostname' || key === '-H') {
        if (hostSeen) throw new Error('Specify hostname only once.');
        hostSeen = true;
        host = value;
      } else {
        if (portSeen) throw new Error('Specify port only once.');
        portSeen = true;
        port = value;
      }
    } else {
      // Never accept Next's positional app-directory argument, inspector, TLS,
      // or arbitrary options. They can bypass the checked root/network boundary.
      const allowed = mode === 'start' ? ['--help', '-h'] : ['--webpack', '--turbopack', '--turbo', '--help', '-h'];
      if (!allowed.includes(args[i])) throw new Error(`Unsupported launch argument: ${key}`);
      forwarded.push(args[i]);
    }
  }
  if (!/^[a-zA-Z0-9.:-]+$/.test(host)) throw new Error('Invalid PIWEB_HOST / hostname.');
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const remote = !LOOPBACK_HOSTS.has(host.toLowerCase());
  const environment = mode === 'preview' ? 'preview' : (env.PIWEB_ENVIRONMENT || (mode === 'dev' ? 'development' : 'production'));
  if (!['production', 'development', 'preview', 'fixture'].includes(environment)) throw new Error('Invalid PIWEB_ENVIRONMENT.');
  if ((environment === 'preview' || environment === 'fixture') && remote) throw new Error('Preview and fixture environments must remain on localhost.');
  if (environment === 'fixture' && !env.PI_CODING_AGENT_DIR) throw new Error('Fixture mode requires an isolated PI_CODING_AGENT_DIR.');
  return {
    command: mode === 'start' ? 'start' : 'dev',
    host, port: Number(port), remote, environment,
    args: [mode === 'start' ? 'start' : 'dev', '--hostname', host, '--port', String(Number(port)), ...forwarded],
  };
}
