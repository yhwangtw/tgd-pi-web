"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import styles from "./FocusDialog.module.css";

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wrap?: boolean;
  onWrapChange?: (wrap: boolean) => void;
  actions?: ReactNode;
}

export function FocusDialog({ open, title, onClose, children, wrap, onWrapChange, actions }: Props) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => closeRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panelRef} className={styles.panel} role="dialog" aria-modal="true" aria-label={title}>
        <header className={styles.header}>
          <span className={styles.title}>{title}</span>
          <div className={styles.actions}>
            {onWrapChange && (
              <button type="button" onClick={() => onWrapChange(!wrap)} aria-pressed={!!wrap}>
                {wrap ? t("code.noWrap") : t("code.wrap")}
              </button>
            )}
            {actions}
            <button ref={closeRef} type="button" className={styles.close} onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
              <X size={16} aria-hidden />
            </button>
          </div>
        </header>
        <div className={styles.content}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
