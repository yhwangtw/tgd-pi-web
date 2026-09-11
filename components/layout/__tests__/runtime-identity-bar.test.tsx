// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeIdentityBar } from '../RuntimeIdentityBar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let version = '2026.09.04';
let fail = false;
const fetchMock = vi.fn(async () => fail ? new Response('', { status: 503 }) : new Response(JSON.stringify({
  environment: 'fixture', agentDir: '/fixture/agent', modelsPath: '/fixture/agent/models.json', cwd: '/fixture/source',
  build: { version, sourceSha: 'abcdef12345', dirty: true, builtAt: '2026-09-07T00:00:00Z' },
})));
beforeEach(() => {
  version = '2026.09.04'; fail = false; fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe('runtime environment presentation', () => {
  it('identifies demonstration data and its actual config path without claiming a release', async () => {
    await act(async () => root.render(<RuntimeIdentityBar />));
    expect(container.querySelector('[data-environment="fixture"]')).toBeTruthy();
    expect(container.textContent).toContain('/fixture/agent/models.json');
    expect(container.textContent).toContain('not a clean release');
  });
  it('refreshes running identity on focus and reconnect', async () => {
    await act(async () => root.render(<RuntimeIdentityBar />));
    version = '2026.09.07';
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toContain('2026.09.07');
    version = '2026.09.08';
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(container.textContent).toContain('2026.09.08');
  });
  it('offers retry when identity cannot be verified', async () => {
    fail = true; await act(async () => root.render(<RuntimeIdentityBar />));
    expect(container.textContent).toContain('Environment unavailable');
    fail = false;
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('/fixture/agent/models.json');
  });
});
