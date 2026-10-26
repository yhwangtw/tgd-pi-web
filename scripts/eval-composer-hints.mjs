// Synthetic, bounded evaluation. No chat commands, session data, telemetry or judge call.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { origin: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, output: { type: 'string' } } });
const origin = new URL(values.origin ?? 'http://127.0.0.1:30177');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !values.provider || !values.model || !values.output) throw Error('Specify a loopback origin, existing provider/model and a new output path.');
const cases = JSON.parse(await readFile(new URL('../evals/composer-hints.json', import.meta.url), 'utf8'));
const results = [];
for (const item of cases) {
  const start = performance.now();
  const request = { provider: values.provider, modelId: values.model, locale: item.name === 'planning-only' ? 'en' : 'zh',
    messages: item.messages, context: item.context, ...(item.excluded ? { excluded: item.excluded } : {}), turnId: `eval:${item.name}:${Date.now()}` };
  try {
    const response = await fetch(new URL('/api/composer-hint', origin), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin.origin }, body: JSON.stringify(request), signal: AbortSignal.timeout(18000) });
    const { hint, status } = await response.json();
    results.push({ name: item.name, http: response.status, status, hint: typeof hint === 'string' ? hint : null, milliseconds: Math.round(performance.now() - start),
      languageCheck: typeof hint === 'string' && (/\p{Script=Han}/u.test(item.messages.findLast(message => message.role === 'user')?.text ?? '') ? /\p{Script=Han}/u.test(hint) : /[a-z]{2}/i.test(hint)),
      lexicalCheck: typeof hint === 'string' && new RegExp(item.required, 'i').test(hint) && !new RegExp(item.forbidden, 'i').test(hint) });
  } catch { results.push({ name: item.name, status: 'unavailable', hint: null, milliseconds: Math.round(performance.now() - start), lexicalCheck: false }); }
}
const sorted = results.map(row => row.milliseconds).sort((a, b) => a - b);
const report = { provider: values.provider, model: values.model, createdAt: new Date().toISOString(), calls: results.length,
  lexicalPasses: results.filter(row => row.lexicalCheck).length, languagePasses: results.filter(row => row.languageCheck).length, medianMilliseconds: (sorted[2] + sorted[3]) / 2,
  note: 'Lexical checks are regression indicators, not proof of semantic correctness. Review the captured hints.', results };
await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ calls: report.calls, lexicalPasses: report.lexicalPasses, languagePasses: report.languagePasses, medianMilliseconds: report.medianMilliseconds, output: values.output }));
