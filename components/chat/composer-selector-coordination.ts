const COMPOSER_SELECTOR_OPEN_EVENT = "pi:composer-selector-open";

export function announceComposerSelectorOpen(id: string): void {
  window.dispatchEvent(new CustomEvent<string>(COMPOSER_SELECTOR_OPEN_EVENT, { detail: id }));
}

export function onAnotherComposerSelectorOpen(id: string, close: () => void): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<string>).detail !== id) close();
  };
  window.addEventListener(COMPOSER_SELECTOR_OPEN_EVENT, listener);
  return () => window.removeEventListener(COMPOSER_SELECTOR_OPEN_EVENT, listener);
}
