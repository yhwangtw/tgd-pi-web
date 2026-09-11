import { describe, expect, it } from 'vitest';
import { resolveServePlan, serveEnvironment } from '../../scripts/serve-plan.mjs';

describe('launch host/port/environment contract', () => {
  it('does not inherit provider credentials or update commands into isolated previews', () => {
    const env = { PATH: '/bin', HOME: '/fixture-home', OPENAI_API_KEY: 'fixture-only', PIWEB_UPDATE_COMMAND_JSON: '["/fake/update"]', NODE_OPTIONS: '--import=private.mjs' };
    const child = serveEnvironment(resolveServePlan('preview'), env, '/isolated/agent');
    expect(child).toMatchObject({ PATH: '/bin', HOME: '/fixture-home', PI_CODING_AGENT_DIR: '/isolated/agent' });
    expect(child).not.toHaveProperty('OPENAI_API_KEY');
    expect(child).not.toHaveProperty('PIWEB_UPDATE_COMMAND_JSON');
    expect(child).not.toHaveProperty('NODE_OPTIONS');
    expect(serveEnvironment(resolveServePlan('start'), env, undefined)).toHaveProperty('OPENAI_API_KEY', 'fixture-only');
  });
  it.each(['dev', 'start'])('%s defaults to loopback, not all interfaces', (mode) => {
    expect(resolveServePlan(mode)).toMatchObject({ host: '127.0.0.1', port: 30141, remote: false });
  });
  it('respects PORT and explicit CLI precedence', () => {
    expect(resolveServePlan('dev', [], { PORT: '30143' }).port).toBe(30143);
    expect(resolveServePlan('dev', ['-p', '30142'], { PORT: '30143' }).args)
      .toEqual(['dev', '--hostname', '127.0.0.1', '--port', '30142']);
  });
  it('does not inherit a generic HOST variable', () => {
    expect(resolveServePlan('dev', [], { HOST: '0.0.0.0' }).host).toBe('127.0.0.1');
  });
  it.each([{ PIWEB_HOST: '0.0.0.0' }, { PIWEB_HOST: '192.168.1.2' }])('allows explicit remote opt-in: %o', (env) => {
    expect(resolveServePlan('start', [], env).remote).toBe(true);
  });
  it('allows an explicit hostname argument and forwards unrelated Next flags', () => {
    expect(resolveServePlan('dev', ['--hostname=0.0.0.0', '--port=4000', '--webpack']))
      .toMatchObject({ remote: true, args: ['dev', '--hostname', '0.0.0.0', '--port', '4000', '--webpack'] });
  });
  it.each(['0', '65536', '-1', '30142x', '3.5', ' 30142', '1e3'])('rejects invalid port %s', (PORT) => {
    expect(() => resolveServePlan('dev', [], { PORT })).toThrow(/PORT/);
  });
  it.each([['-p'], ['--hostname'], ['-H0.0.0.0'], ['-p4000'], ['-p', '1', '--port', '2'], ['--hostname', 'localhost', '-H', '::1']].map((args) => ({ args })))('rejects ambiguous arguments $args', ({ args }) => {
    expect(() => resolveServePlan('dev', args)).toThrow();
  });
  it('keeps preview separate and localhost-only', () => {
    expect(resolveServePlan('preview')).toMatchObject({ port: 30142, environment: 'preview' });
    expect(() => resolveServePlan('preview', ['-H', '0.0.0.0'])).toThrow(/localhost/);
  });
  it('requires explicitly isolated data for fixtures', () => {
    expect(() => resolveServePlan('dev', [], { PIWEB_ENVIRONMENT: 'fixture' })).toThrow(/isolated/);
  });
  it.each([['/tmp/another-app'], ['--inspect=0.0.0.0:9229'], ['--experimental-https']].map((args) => ({ args })))('cannot bypass the app root or expose a debug listener: $args', ({ args }) => {
    expect(() => resolveServePlan('preview', args)).toThrow(/argument/);
  });
  it.each(['preview', 'fixture'])('enforces loopback for explicit %s environment, not only the preview subcommand', (PIWEB_ENVIRONMENT) => {
    expect(() => resolveServePlan('dev', ['-H', '0.0.0.0'], { PIWEB_ENVIRONMENT, PI_CODING_AGENT_DIR: '/isolated/agent' })).toThrow(/localhost/);
  });
});
