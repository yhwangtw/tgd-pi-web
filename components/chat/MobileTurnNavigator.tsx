"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import styles from "./MobileTurnNavigator.module.css";

export interface MobileTurnItem {
  entryId?: string;
  visibleIndex: number;
  preview: string;
  bookmarked: boolean;
}

interface Props {
  turns: MobileTurnItem[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}

export function MobileTurnNavigator({ turns, scrollContainer, messageRefs }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [bookmarksOnly, setBookmarksOnly] = useState(false);
  const [current, setCurrent] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const container = scrollContainer.current;
    if (!container) return;
    const updateCurrent = () => {
      if (turns.length === 0) return;
      const top = container.getBoundingClientRect().top + 48;
      let next = 0;
      turns.forEach((turn, index) => {
        const element = messageRefs.current[turn.visibleIndex];
        if (element && element.getBoundingClientRect().top <= top) next = index;
      });
      setCurrent(next);
    };
    updateCurrent();
    container.addEventListener("scroll", updateCurrent, { passive: true });
    return () => container.removeEventListener("scroll", updateCurrent);
  }, [messageRefs, scrollContainer, turns]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const visibleTurns = bookmarksOnly ? turns.filter((turn) => turn.bookmarked) : turns;
  if (turns.length < 2) return null;

  return (
    <>
      <button type="button" className={styles.trigger} onClick={() => setOpen(true)} aria-label={t("chat.turns")}>
        <span className={styles.triggerLabel}>{t("chat.turns")}</span>
        <span>{Math.min(current + 1, turns.length)}/{turns.length}</span>
        {turns.some((turn) => turn.bookmarked) && <span className={styles.star} aria-hidden>★</span>}
      </button>
      {open && (
        <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className={styles.sheet} role="dialog" aria-modal="true" aria-label={t("chat.turns")}>
            <header className={styles.header}>
              <strong>{t("chat.turns")}</strong>
              <div className={styles.headerActions}>
                <button type="button" aria-pressed={bookmarksOnly} onClick={() => setBookmarksOnly((value) => !value)}>
                  ★ {t("chat.bookmarks")}
                </button>
                <button ref={closeRef} type="button" className={styles.close} onClick={() => setOpen(false)} aria-label={t("common.close")}>
                  <X size={16} aria-hidden />
                </button>
              </div>
            </header>
            <div className={styles.list}>
              {visibleTurns.length === 0 && <div className={styles.empty}>{t("chat.noTurns")}</div>}
              {visibleTurns.map((turn) => {
                const absoluteIndex = turns.indexOf(turn);
                return (
                  <button
                    key={turn.entryId ?? turn.visibleIndex}
                    type="button"
                    className={`${styles.turn} ${absoluteIndex === current ? styles.turnCurrent : ""}`}
                    onClick={() => {
                      messageRefs.current[turn.visibleIndex]?.scrollIntoView({ block: "start", behavior: "smooth" });
                      setOpen(false);
                    }}
                  >
                    <span className={styles.number}>{absoluteIndex + 1}</span>
                    <span className={styles.preview}>{turn.preview}</span>
                    {turn.bookmarked && <span className={styles.star} aria-label={t("chat.bookmark")}>★</span>}
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
