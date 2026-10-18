"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, X } from "lucide-react";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useI18n } from "@/lib/i18n";
import { IconButton } from "./IconButton";
import styles from "./DialogShell.module.css";

export function DialogShell({
  open,
  title,
  description,
  descriptionDetail,
  onClose,
  canClose = true,
  hasUnsavedChanges = false,
  size = "default",
  mobileMode = "sheet",
  modal = false,
  placement = "corner",
  initialFocusRef,
  headerActions,
  footer,
  bodyClassName,
  testId,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  descriptionDetail?: string;
  onClose: () => void;
  canClose?: boolean;
  /** Ask before dismissing an edited form through the backdrop, Escape or X. */
  hasUnsavedChanges?: boolean;
  size?: "compact" | "default" | "wide" | "xwide";
  mobileMode?: "sheet" | "fullscreen";
  /** Opt in only for a genuinely blocking flow; normal panels stay modeless. */
  modal?: boolean;
  /** Center a picker on desktop and honor its sheet/fullscreen mode on phones. */
  placement?: "corner" | "center";
  initialFocusRef?: RefObject<HTMLElement | null>;
  headerActions?: ReactNode;
  footer?: ReactNode;
  bodyClassName?: string;
  testId?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const requestClose = () => {
    if (!canClose) return;
    if (hasUnsavedChanges && !window.confirm(t("common.discardUnsavedChanges"))) return;
    onClose();
  };
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  const pointerInsideReactTree = useRef(false);
  const { panelRef } = useModalDialog<HTMLElement>({ open: open && modal, onClose: requestClose, canClose, initialFocusRef });

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const root = panel?.closest("[data-dialog-root]");
    const isTopDialog = () => [...document.querySelectorAll("[data-dialog-root]")].at(-1) === root;
    let outsidePress = false;
    const startPress = (event: PointerEvent) => {
      pointerInsideReactTree.current = false;
      outsidePress = event.button === 0 && event.isPrimary !== false && isTopDialog()
        && !panel?.contains(event.target as Node);
    };
    const cancelPress = () => { outsidePress = false; };
    const finishPress = (event: MouseEvent) => {
      const shouldDismiss = outsidePress && !pointerInsideReactTree.current;
      outsidePress = false;
      // Require a complete outside gesture. Opening clicks, text selections,
      // canceled touch gestures and clicks in a child portal must not dismiss.
      if (!shouldDismiss || event.button !== 0 || !isTopDialog() || panel?.contains(event.target as Node)) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", startPress, true);
    document.addEventListener("pointercancel", cancelPress, true);
    document.addEventListener("click", finishPress);
    return () => {
      document.removeEventListener("pointerdown", startPress, true);
      document.removeEventListener("pointercancel", cancelPress, true);
      document.removeEventListener("click", finishPress);
    };
  }, [open, panelRef]);
  useEffect(() => {
    if (!open || modal) return;
    const panel = panelRef.current;
    const launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let focusedInside = false;
    const trackFocus = (event: FocusEvent) => { focusedInside = !!panel?.contains(event.target as Node); };
    const trackPointer = (event: PointerEvent) => {
      if (!panel?.contains(event.target as Node)) focusedInside = false;
    };
    document.addEventListener("focusin", trackFocus);
    document.addEventListener("pointerdown", trackPointer, true);
    // Explicitly opened search/picker flows can nominate a starting field.
    // Otherwise modeless panels leave the current editor untouched.
    initialFocusRef?.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("focusin", trackFocus);
      document.removeEventListener("pointerdown", trackPointer, true);
      // Return keyboard users to their launcher, but never pull focus away
      // from a composer they chose while this modeless panel was open.
      if (focusedInside && launcher?.isConnected && (panel?.contains(document.activeElement) || document.activeElement === document.body)) launcher.focus();
    };
  }, [open, modal, panelRef, initialFocusRef]);
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={styles.overlay}
      data-dialog-root
      data-modeless={!modal || undefined}
      data-placement={placement}
    >
      <section
        ref={panelRef}
        className={styles.dialog}
        role="dialog"
        aria-modal={modal || undefined}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-size={size}
        data-mobile-mode={mobileMode}
        data-testid={testId}
        onPointerDownCapture={() => { pointerInsideReactTree.current = true; }}
        onClickCapture={() => { pointerInsideReactTree.current = true; }}
        onKeyDown={(event) => {
          if (!modal && canClose && !event.defaultPrevented && event.key === "Escape") { event.stopPropagation(); requestClose(); }
        }}
      >
        <header className={styles.header}>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
            {descriptionDetail && <details className={styles.descriptionDetail}><summary>{t("common.details")}</summary><p>{descriptionDetail}</p></details>}
          </div>
          <div className={styles.headerActions}>
            {headerActions}
            {!modal && <IconButton className={styles.collapse} aria-expanded={!collapsed} label={t(collapsed ? "interaction.expand" : "interaction.minimize")} onClick={() => setCollapsed(!collapsed)} icon={collapsed ? <Plus /> : <Minus />} />}
            <IconButton
              className={styles.close}
              label={t("common.close")}
              icon={<X />}
              onClick={requestClose}
              disabled={!canClose}
            />
          </div>
        </header>
        <div hidden={!modal && collapsed} className={[styles.body, bodyClassName].filter(Boolean).join(" ")}>{children}</div>
        {footer && <footer hidden={!modal && collapsed} className={styles.footer}>{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}
