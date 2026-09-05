"use client";

import { useEffect, useRef, type RefObject } from "react";

let bodyLockCount = 0;
let bodyOverflowBeforeLock = "";
type BodyElementState = {
  inert: boolean;
  ariaHidden: string | null;
};

type ModalRegistration = {
  id: symbol;
  root: HTMLElement;
};

const modalStack: ModalRegistration[] = [];
const bodyElementStates = new Map<HTMLElement, BodyElementState>();
let bodyObserver: MutationObserver | null = null;

function lockBody(): () => void {
  if (bodyLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyLockCount += 1;
  return () => {
    bodyLockCount = Math.max(0, bodyLockCount - 1);
    if (bodyLockCount === 0) document.body.style.overflow = bodyOverflowBeforeLock;
  };
}

function bodyChildren(): HTMLElement[] {
  return [...document.body.children]
    .filter((element): element is HTMLElement => element instanceof HTMLElement);
}

function rememberBodyElement(element: HTMLElement): BodyElementState {
  const existing = bodyElementStates.get(element);
  if (existing) return existing;
  const state = {
    inert: element.inert,
    ariaHidden: element.getAttribute("aria-hidden"),
  };
  bodyElementStates.set(element, state);
  return state;
}

function restoreElement(element: HTMLElement, state: BodyElementState) {
  element.inert = state.inert;
  if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", state.ariaHidden);
}

function topModal(): ModalRegistration | undefined {
  for (let index = modalStack.length - 1; index >= 0; index -= 1) {
    if (modalStack[index].root.isConnected) return modalStack[index];
  }
  return undefined;
}

function syncModalIsolation() {
  const activeRoot = topModal()?.root;
  if (!activeRoot) {
    for (const [element, state] of bodyElementStates) restoreElement(element, state);
    bodyElementStates.clear();
    bodyObserver?.disconnect();
    bodyObserver = null;
    return;
  }

  for (const element of bodyChildren()) {
    const state = rememberBodyElement(element);
    if (element === activeRoot) restoreElement(element, state);
    else {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
  }
}

function registerModal(panel: HTMLElement | null): {
  isTop: () => boolean;
  unregister: () => void;
} {
  const modalRoot = panel?.closest<HTMLElement>("[data-dialog-root]");
  if (!modalRoot) return { isTop: () => false, unregister: () => {} };

  const registration = { id: Symbol("modal"), root: modalRoot };
  modalStack.push(registration);
  if (!bodyObserver) {
    bodyObserver = new MutationObserver(() => syncModalIsolation());
    bodyObserver.observe(document.body, { childList: true });
  }
  syncModalIsolation();

  return {
    isTop: () => topModal()?.id === registration.id,
    unregister: () => {
      const index = modalStack.findIndex(({ id }) => id === registration.id);
      if (index >= 0) modalStack.splice(index, 1);
      syncModalIsolation();
    },
  };
}

const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useModalDialog<T extends HTMLElement = HTMLElement>({
  open,
  onClose,
  canClose = true,
  initialFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  canClose?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const panelRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  const initialFocusRefRef = useRef(initialFocusRef);
  onCloseRef.current = onClose;
  canCloseRef.current = canClose;
  initialFocusRefRef.current = initialFocusRef;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unlockBody = lockBody();
    const modal = registerModal(panelRef.current);
    const focusFrame = requestAnimationFrame(() => {
      // A fast keyboard/pointer interaction may have already chosen a control.
      // Delayed initial focus must never override that choice.
      if (panelRef.current?.contains(document.activeElement)) return;
      const first = initialFocusRefRef.current?.current
        ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        ?? panelRef.current;
      first?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!modal.isTop()) return;
      if (event.key === "Escape" && canCloseRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panelRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown, true);
      unlockBody();
      modal.unregister();
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  return { panelRef };
}
