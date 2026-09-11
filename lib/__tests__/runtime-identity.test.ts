import { describe, expect, it } from 'vitest';
import { createRuntimeIdentity, runtimeEnvironment } from '../runtime-identity';

describe('runtime identity', () => {
  it.each(['production', 'development', 'preview', 'fixture'] as const)('uses explicit %s identity', (environment) => {
    expect(runtimeEnvironment({ PIWEB_ENVIRONMENT: environment, NODE_ENV: 'production' })).toBe(environment);
  });
  it('does not guess fixture isolation from a directory name', () => {
    expect(runtimeEnvironment({ NODE_ENV: 'development', PI_CODING_AGENT_DIR: '/tmp/test-agent' })).toBe('development');
    expect(runtimeEnvironment({ NODE_ENV: 'development', PIWEB_ENVIRONMENT: 'fake' })).toBe('unknown');
  });
  it('reports the actual agent path and captured build, not workspace git state', () => {
    const build = { version: '2026.09.04', sourceSha: 'abc123', dirty: false, builtAt: '2026-09-07T00:00:00Z' };
    expect(createRuntimeIdentity({ NODE_ENV: 'development', PIWEB_ENVIRONMENT: 'fixture' }, {
      agentDir: '/tmp/preview/agent', cwd: '/tmp/worktree', pid: 42, startedAt: 'now',
    }, build)).toMatchObject({
      environment: 'fixture', modelsPath: '/tmp/preview/agent/models.json', build,
    });
  });
});
