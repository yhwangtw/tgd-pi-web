"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { X } from "lucide-react";

import { useId, type ComponentProps } from "react";
import type { DialogShell } from "./DialogShell";
import { useI18n } from "@/lib/i18n";
import styles from "./InlinePanel.module.css";

/** A review stays in its owning surface: no portal, focus trap or body lock. */
export function InlinePanel({ open, title, description, onClose, canClose = true, footer, children, testId }: ComponentProps<typeof DialogShell>) {
  const id = useId();
  const { t } = useI18n();
  if (!open) return null;
  return <section className={styles.panel} aria-labelledby={id} data-testid={testId}>
    <header><div><h3 id={id}>{title}</h3>{description && <p>{description}</p>}</div>
      <button type="button" onClick={onClose} disabled={!canClose} aria-label={t("common.close")}><X size={UI_ICON_SIZE.control} aria-hidden="true" /></button>
    </header>
    <div className={styles.body}>{children}</div>
    {footer && <footer>{footer}</footer>}
  </section>;
}
