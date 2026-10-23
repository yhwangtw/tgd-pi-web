"use client";

import { useId } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useModalDialog } from "@/hooks/useModalDialog";
import { IconButton } from "@/components/ui/IconButton";
import { useI18n } from "@/lib/i18n";
import s from "./AppShell.module.css";

/** Keyboard-shortcuts cheat sheet — opened from the ⌘K palette's help action. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();

  const titleId = useId();
  const { panelRef } = useModalDialog<HTMLDivElement>({ open: true, onClose });
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      data-dialog-root
      className={s.shortcutsOverlay}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={panelRef} className={s.shortcutsDialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className={s.shortcutsHeader}>
          <h3 id={titleId} className={s.shortcutsTitle}>{t("shortcuts.title")}</h3>
          <IconButton label={t("common.close")} icon={<X />} onClick={onClose} />
        </header>
        {([
          ["⌘K", t("shortcuts.palette")],
          ["⌘F", t("shortcuts.find")],
          ["⌥↑ / ⌥↓", t("shortcuts.turnNav")],
          ["⇧⌘M", t("shortcuts.models")],
          ["⌘/", t("shortcuts.skills")],
          ["⌘B", t("shortcuts.sidebar")],
          ["⌘\\", t("shortcuts.filePanel")],
          ["Esc", t("shortcuts.close")],
        ] as [string, string][]).map(([keys, label]) => (
          <div key={keys} className={s.shortcutRow}>
            <span>{label}</span>
            <span className={s.shortcutKbd}>{keys}</span>
          </div>
        ))}
      </div>
    </div>, document.body,
  );
}
