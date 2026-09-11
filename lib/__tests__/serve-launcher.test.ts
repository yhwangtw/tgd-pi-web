import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('actual launcher process', () => {
  it('passes loopback/PORT, records the child, and cleans its own marker', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-launcher-'))); roots.push(root);
    for (const path of ['scripts/serve.mjs', 'scripts/serve-plan.mjs', 'scripts/preview-data.mjs', 'lib/node-support.mjs']) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); copyFileSync(join(process.cwd(), path), join(root, path));
    }
    const next = join(root, 'node_modules/next/dist/bin/next'); mkdirSync(dirname(next), { recursive: true });
    writeFileSync(next, `const fs=require('fs');const dir='.piweb-runtime';setTimeout(()=>{const record=JSON.parse(fs.readFileSync(dir+'/'+fs.readdirSync(dir)[0],'utf8'));console.log('RESULT:'+JSON.stringify({args:process.argv.slice(2),environment:process.env.PIWEB_ENVIRONMENT,record,pid:process.pid}));},20);`);
    const { PIWEB_HOST: _host, PIWEB_ENVIRONMENT: _environment, PI_CODING_AGENT_DIR: _agent, ...env } = process.env;
    void _host; void _environment; void _agent;
    const result = spawnSync(process.execPath, [join(root, 'scripts/serve.mjs'), 'dev'], { cwd: root, env: { ...env, PORT: '30149' }, encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split('\n').find((text) => text.startsWith('RESULT:'))!;
    const output = JSON.parse(line.slice(7));
    expect(output.args).toEqual(['dev', '--hostname', '127.0.0.1', '--port', '30149']);
    expect(output.record).toMatchObject({ cwd: root, childPid: output.pid, port: 30149, buildId: null });
    expect(output.environment).toBe('development');
    expect(readdirSync(join(root, '.piweb-runtime'))).toEqual([]);
  });
});
