// A separate process is intentionally killed by the regression test. Node's
// native TS loader keeps this fixture independent from a development server.
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai-durable';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';

registerHooks({ resolve(specifier, context, next) {
  if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) {
    try { return next(`${specifier}.ts`, context); } catch { /* normal resolution below */ }
  }
  return next(specifier, context);
} });
const { openDurableAgentRun } = await import('../../durable-agent-run.ts');
const run = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// Keep the fixture alive until the parent actually SIGKILLs it, rather than
// letting Node exit on an unresolved promise and clean the lease normally.
const keepAlive = setInterval(() => {}, 1_000);
const faux = fauxProvider({ provider: 'durable-test', models: [{ id: 'test' }], tokensPerSecond: 0 });
faux.setResponses([fauxAssistantMessage(fauxToolCall('side_effect', {}), { stopReason: 'toolUse' })]);
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(defineExtension({ name: 'test-tools', tools: [defineTool({
  name: 'side_effect', description: 'Side effect', parameters: Type.Object({}),
  execute: async () => {
    writeFileSync(join(run.cwd, 'effect.txt'), 'once');
    process.send('effect-written');
    await new Promise(() => {});
    return {};
  },
})] }));
const handle = await openDurableAgentRun(run, { directory: run.cwd, models, registry });
await handle.run();
await handle.close();
clearInterval(keepAlive);
