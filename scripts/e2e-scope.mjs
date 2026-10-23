import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep real navigation, streaming/reconnection and Durable coverage in every
// focused run. Anything outside the explicitly mapped UI leaves runs all specs.
export const CORE_SPECS = ['chat', 'nav', 'session-reconnect', 'durable-chat', 'appearance', 'responsive', 'design-audit', 'js-budget']
  .map(name => `e2e/${name}.spec.ts`);
const fileSpecs = ['file-browser-layout', 'file-review-focus', 'file-links', 'file-edit-safety',
  'file-response-safety', 'viewer', 'diff-review', 'audit-refinements', 'ui-audit-fixes'];
const composerSpecs = ['composer-overlay-layout', 'model-streaming-mobile', 'model-recovery',
  'file-attachments', 'screenshot', 'mention', 'transcript-follow', 'workflow-preview-controls',
  'new-conversation', 'ask-user-inline', 'compaction', 'audit-refinements', 'ui-audit-fixes'];
const leaves = new Map([
  ...['FilesPanel', 'FileViewer', 'TextFileViewer', 'FileInspectorDrawer'].flatMap(name =>
    ['tsx', 'module.css'].map(ext => [`components/layout/${name}.${ext}`, fileSpecs])),
  ...['ChatInput.tsx', 'ChatInput.module.css', 'ModelSelector.tsx', 'ComposerSelector.module.css',
    'FileMentionMenu.tsx', 'FileMentionMenu.module.css', 'useComposerPopupPosition.ts'].map(name =>
    [`components/chat/${name}`, composerSpecs]),
]);
for (const name of ['BinaryViewer', 'DocumentViewer', 'ImageViewer', 'MediaViewer', 'VideoViewer', 'DiffView', 'DiffPanel', 'TabBar']) {
  for (const ext of ['tsx', 'module.css']) leaves.set(`components/layout/${name}.${ext}`, fileSpecs);
}
for (const name of ['StructuredDataView', 'HtmlPreview', 'PlainSourceView', 'DiffViewMode', 'PreviewView', 'SourceView']) {
  for (const ext of ['tsx', 'module.css']) leaves.set(`components/layout/text-viewer/${name}.${ext}`, fileSpecs);
}
const isUnitTest = file => /^(?:components|hooks|lib|scripts)\/(?:[^/]+\/)*__tests__\/[^/]+\.test\.(?:[cm]?js|tsx?)$/.test(file)
  || /^(?:components|hooks|lib|scripts)\/(?:[^/]+\/)*[^/]+\.test\.(?:[cm]?js|tsx?)$/.test(file);
const isDoc = file => /^(?:README(?:\.[\w-]+)?\.md|AGENTS\.md|LICENSE(?:\.md)?|docs\/.*\.(?:md|png|jpe?g|svg|webp))$/.test(file);

export function selectE2E(files, profile, exists = existsSync) {
  const full = { mode: 'full', specs: [] };
  if (profile === 'docs') return { mode: 'none', specs: [] };
  if (profile !== 'normal' || !files.length) return full;
  const specs = new Set(CORE_SPECS);
  for (const file of files) {
    if (isDoc(file)) continue;
    if (isUnitTest(file)) { if (!exists(file)) return full; continue; }
    if (/^e2e\/[\w-]+\.spec\.ts$/.test(file)) { specs.add(file); continue; }
    const related = leaves.get(file);
    if (!related || !exists(file)) return full;
    for (const name of related) specs.add(`e2e/${name}.spec.ts`);
  }
  // Deleted/renamed tests or stale mappings must not silently reduce coverage.
  if ([...specs].some(file => !exists(file))) return full;
  return { mode: 'focused', specs: [...specs].sort() };
}

export function selectedTestMatch(raw, root = process.cwd()) {
  if (!raw) return undefined;
  const files = JSON.parse(raw);
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string'
    || !/^e2e\/[\w-]+\.spec\.ts$/.test(file) || !existsSync(resolve(root, file)))) {
    throw new Error('Invalid E2E selection; use an existing explicit spec list or [] for the full suite');
  }
  return files.length ? files.map(file => `**/${file.slice(4)}`) : undefined;
}
