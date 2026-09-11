import { join } from 'node:path';

export type RuntimeEnvironment = 'production' | 'development' | 'preview' | 'fixture' | 'unknown';
export interface RuntimeIdentity {
  environment: RuntimeEnvironment;
  agentDir: string;
  modelsPath: string;
  cwd: string;
  pid: number;
  startedAt: string;
  build: { version: string; sourceSha: string | null; dirty: boolean | null; builtAt: string | null };
}

export function runtimeEnvironment(env: NodeJS.ProcessEnv): RuntimeEnvironment {
  const explicit = env.PIWEB_ENVIRONMENT;
  if (explicit) return ['production', 'development', 'preview', 'fixture'].includes(explicit) ? explicit as RuntimeEnvironment : 'unknown';
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}

export function createRuntimeIdentity(
  env: NodeJS.ProcessEnv,
  runtime: { agentDir: string; cwd: string; pid: number; startedAt: string },
  build: RuntimeIdentity['build'],
): RuntimeIdentity {
  return { ...runtime, environment: runtimeEnvironment(env), modelsPath: join(runtime.agentDir, 'models.json'), build };
}
