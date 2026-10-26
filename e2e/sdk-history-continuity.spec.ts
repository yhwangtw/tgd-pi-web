import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('converted bookmark, saved workflow and history continue through the SDK', async ({ page, baseURL }, info) => {
  if (!process.env.E2E_ROOT || !process.env.E2E_PROJECT_CWD || !baseURL) throw new Error('Isolated fixture required');
  const origin = new URL(baseURL).origin;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) return route.abort();
    if (url.pathname === '/api/composer-hint') return route.fulfill({ json: { hint: '' } });
    return route.continue();
  });
  await page.addInitScript(() => { localStorage.setItem('pi-locale', 'en'); localStorage.setItem('pi-ui-style', 'original'); });
  const id = 'dw_00000000-0000-0000-0000-000000000099_1';
  const created = '2026-10-26T01:00:00.000Z';
  const conversion = { id, entries: [{ id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'Saved conversation before the runtime change', timestamp: Date.parse(created) }] }],
    agent: { cwd: process.env.E2E_PROJECT_CWD, model: { provider: 'e2e-reconnect-fixture', modelId: 'deterministic' }, thinkingLevel: 'off' },
    meta: { name: 'Converted SDK history' }, created, parentSession: undefined,
    workflow: { version: 1, goal: { id: 'saved-goal', objective: 'Preserve the historical task', status: 'active', tokens: 10, automaticRuns: 1 }, plan: null } };
  const files = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', 'import {convertArchive} from "./scripts/convert-session-archive.mjs"; import {readFileSync} from "node:fs"; process.stdout.write(JSON.stringify(convertArchive(JSON.parse(readFileSync(0, "utf8")))));'], { input: JSON.stringify(conversion), encoding: 'utf8' })) as Array<Record<string, unknown>>;
  const directory = join(process.env.E2E_ROOT, 'agent', 'sessions', '-sdk-conversion');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.jsonl`), files.map(e => JSON.stringify(e)).join('\n') + '\n');
  const read = await page.request.get(`/api/sessions/${id}`);
  expect(read.ok()).toBe(true);
  expect(await read.json()).toMatchObject({ sessionId: id });
  await page.goto(`/?session=${id}`);
  await expect(page.getByText('Saved conversation before the runtime change', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Durable/ })).toHaveCount(0);
  const state = await page.request.post(`/api/agent/${id}`, { data: { type: 'get_state' } });
  expect(state.ok()).toBe(true);
  const input = page.getByRole('textbox', { name: 'Message…', exact: true });
  await input.fill('E2E_RECONNECT:complete:converted-sdk');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('assistant-message').filter({ hasText: 'converted-sdk' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByText('Saved conversation before the runtime change', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('assistant-message').filter({ hasText: 'converted-sdk' })).toBeVisible();
  const exported = await page.request.get(`/api/sessions/${id}/export-md`);
  expect(exported.ok()).toBe(true);
  expect(await exported.text()).toContain('Saved conversation before the runtime change');
  await page.screenshot({ path: info.outputPath('converted-sdk-history.png') });
});
