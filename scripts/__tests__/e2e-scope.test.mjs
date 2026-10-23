import { describe, expect, it } from 'vitest';
import { CORE_SPECS, selectE2E, selectedTestMatch } from '../e2e-scope.mjs';

describe('E2E coverage selection', () => {
  it('retains core flows and related file/composer coverage for known UI leaves', () => {
    const selected = selectE2E(['components/layout/FileViewer.module.css', 'components/chat/ChatInput.tsx', 'README.md'], 'normal');
    expect(selected.mode).toBe('focused');
    expect(selected.specs).toEqual(expect.arrayContaining([...CORE_SPECS, 'e2e/file-browser-layout.spec.ts', 'e2e/screenshot.spec.ts']));
    expect(new Set(selected.specs).size).toBe(selected.specs.length);
    expect(selectedTestMatch(JSON.stringify(selected.specs))).toHaveLength(selected.specs.length);
  });
  it('keeps known viewer leaves and colocated unit tests focused without ignoring shared harnesses', () => {
    expect(selectE2E(['components/layout/text-viewer/SourceView.tsx'], 'normal').mode).toBe('focused');
    expect(selectE2E(['components/chat/ChatInput.tsx', 'components/chat/__tests__/chat-input-actions.test.tsx'], 'normal').mode).toBe('focused');
    expect(selectE2E(['components/layout/text-viewer/SourceView.tsx'], 'normal', file => file !== 'components/layout/text-viewer/SourceView.tsx').mode).toBe('full');
    expect(selectE2E(['components/chat/__tests__/deleted.test.tsx'], 'normal', () => false).mode).toBe('full');
    for (const file of ['test/setup.ts', 'e2e/global-setup.ts', 'e2e/helpers.ts', 'playwright.config.ts', 'vitest.config.ts', 'components/chat/__tests__/fixture.ts']) {
      expect(selectE2E([file], 'normal').mode).toBe('full');
    }
  });
  it('falls back to full coverage for global/runtime/unknown changes and incomplete mappings', () => {
    for (const file of ['lib/agent-runtime.ts', 'app/globals.css', 'components/ui/DialogShell.tsx',
      'next.config.ts', 'e2e/fixtures.ts', 'lib/sessions.ts', 'components/chat/NewUnknown.tsx']) {
      expect(selectE2E(['components/chat/ChatInput.tsx', file], 'normal')).toEqual({ mode: 'full', specs: [] });
    }
    expect(selectE2E(['components/chat/ChatInput.tsx'], 'compatibility').mode).toBe('full');
    expect(selectE2E([], 'normal').mode).toBe('full');
    expect(selectE2E(['e2e/deleted.spec.ts'], 'normal').mode).toBe('full');
    expect(selectE2E(['components/chat/ChatInput.tsx'], 'normal', () => false).mode).toBe('full');
    expect(selectE2E(['README.md'], 'docs').mode).toBe('none');
  });
  it('runs newly changed specs alongside core flows and rejects invalid runtime selections', () => {
    expect(selectE2E(['e2e/screenshot.spec.ts'], 'normal').specs).toContain('e2e/screenshot.spec.ts');
    expect(selectedTestMatch('[]')).toBeUndefined();
    for (const raw of ['{}', '[null]', '["../outside.spec.ts"]', '["e2e/missing.spec.ts"]', '["e2e/*.spec.ts"]']) {
      expect(() => selectedTestMatch(raw)).toThrow();
    }
  });
});
