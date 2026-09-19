"use client";

import { useEffect, useId, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useI18n } from "@/lib/i18n";
import { IconButton } from "./IconButton";
import styles from "./DialogShell.module.css";

export function DialogShell({
  open,
  title,
  description,
  onClose,
  canClose = true,
  size = "default",
  mobileMode = "sheet",
  modal = false,
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
  onClose: () => void;
  canClose?: boolean;
  size?: "compact" | "default" | "wide" | "xwide";
  mobileMode?: "sheet" | "fullscreen";
  /** Opt in only for a genuinely blocking flow; normal panels stay modeless. */
  modal?: boolean;
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
  const { panelRef } = useModalDialog<HTMLElement>({ open: open && modal, onClose, canClose, initialFocusRef });
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
      onMouseDown={(event) => {
        if (modal && canClose && event.target === event.currentTarget) onClose();
      }}
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
        onKeyDown={(event) => {
          if (!modal && canClose && event.key === "Escape") { event.stopPropagation(); onClose(); }
        }}
      >
        <header className={styles.header}>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <div className={styles.headerActions}>
            {headerActions}
            {!modal && <button className={styles.collapse} type="button" aria-expanded={!collapsed} aria-label={t(collapsed ? "interaction.expand" : "interaction.minimize")} onClick={() => setCollapsed(!collapsed)}>{collapsed ? "+" : "−"}</button>}
            <IconButton
              label={t("common.close")}
              icon={<X strokeWidth={1.8} />}
              onClick={onClose}
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
