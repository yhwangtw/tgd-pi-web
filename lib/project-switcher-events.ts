const OPEN_PROJECT_SWITCHER_EVENT = "pi:open-project-switcher";

export function requestOpenProjectSwitcher(options?: { startNewSession?: boolean }): void {
  window.dispatchEvent(new CustomEvent(OPEN_PROJECT_SWITCHER_EVENT, { detail: options }));
}

export function onOpenProjectSwitcher(listener: (startNewSession: boolean) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<{ startNewSession?: boolean }>).detail?.startNewSession === true);
  window.addEventListener(OPEN_PROJECT_SWITCHER_EVENT, handler);
  return () => window.removeEventListener(OPEN_PROJECT_SWITCHER_EVENT, handler);
}
