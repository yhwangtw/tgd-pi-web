"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n";
import s from "./AppShell.module.css";

/** Keyboard-shortcuts cheat sheet — opened from the ⌘K palette's help action. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={s.shortcutsOverlay}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={t("shortcuts.title")}
    >
      <div className={s.shortcutsDialog}>
        <h3 className={s.shortcutsTitle}>{t("shortcuts.title")}</h3>
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
    </div>
  );
}
