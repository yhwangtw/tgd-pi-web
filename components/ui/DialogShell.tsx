"use client";

import { useId, type ReactNode, type RefObject } from "react";
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
  const { panelRef } = useModalDialog<HTMLElement>({ open, onClose, canClose, initialFocusRef });
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={styles.overlay}
      data-dialog-root
      onMouseDown={(event) => {
        if (canClose && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-size={size}
        data-mobile-mode={mobileMode}
        data-testid={testId}
      >
        <header className={styles.header}>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <div className={styles.headerActions}>
            {headerActions}
            <IconButton
              label={t("common.close")}
              icon={<X strokeWidth={1.8} />}
              onClick={onClose}
              disabled={!canClose}
            />
          </div>
        </header>
        <div className={[styles.body, bodyClassName].filter(Boolean).join(" ")}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}
