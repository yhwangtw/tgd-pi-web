"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bookmark, List, X } from "lucide-react";
import { UI_ICON_SIZE } from "@/lib/ui-icons";
import { useI18n } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { motionScrollBehavior } from "@/lib/motion";
import styles from "./MobileTurnNavigator.module.css";

export interface MobileTurnItem {
  entryId?: string;
  visibleIndex: number;
  preview: string;
  bookmarked: boolean;
  turnNumber?: number;
}

interface Props {
  turns: MobileTurnItem[];
  bookmarkedMessages?: MobileTurnItem[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  onNavigate?: (visibleIndex: number) => void;
}

export function MobileTurnNavigator({ turns, bookmarkedMessages, scrollContainer, messageRefs, onNavigate }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [bookmarksOnly, setBookmarksOnly] = useState(false);
  const [current, setCurrent] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bookmarks = bookmarkedMessages ?? turns.filter(turn => turn.bookmarked);
  const available = turns.length > 1 || bookmarks.length > 0;
  const dialogOpen = open && mobile && available;
  const close = useCallback(() => setOpen(false), []);
  const { panelRef } = useModalDialog<HTMLElement>({ open: dialogOpen, onClose: close, initialFocusRef: closeRef });

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia("(max-width: 700px)");
    const update = () => { setMobile(query.matches); if (!query.matches) setOpen(false); };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const container = scrollContainer.current;
    if (!mobile || !available || !container) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = container.getBoundingClientRect().top + 48;
      let next: number | null = null;
      turns.forEach((turn, index) => {
        const element = messageRefs.current[turn.visibleIndex];
        if (!element) return;
        if (next === null) next = Math.max(0, index - 1);
        if (element.getBoundingClientRect().top <= top) next = index;
      });
      if (next !== null) setCurrent(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    schedule();
    container.addEventListener("scroll", schedule, { passive: true });
    return () => { cancelAnimationFrame(frame); container.removeEventListener("scroll", schedule); };
  }, [available, messageRefs, mobile, scrollContainer, turns]);

  if (!mobile || !available) return null;
  const visibleTurns = bookmarksOnly ? bookmarks : turns;

  return (
    <>
      <button type="button" className={styles.trigger} onClick={() => setOpen(true)} aria-label={t("chat.turns")} aria-haspopup="dialog" aria-expanded={dialogOpen}>
        <List size={UI_ICON_SIZE.compact} aria-hidden />
        <span className={styles.triggerLabel}>{t("chat.turns")}</span>
        <span>{turns.length ? `${Math.min(current + 1, turns.length)}/${turns.length}` : bookmarks.length}</span>
        {bookmarks.length > 0 && <Bookmark className={styles.star} size={UI_ICON_SIZE.inline} aria-hidden />}
      </button>
      {dialogOpen && createPortal(
        <div className={styles.backdrop} data-dialog-root onPointerDown={event => { if (event.target === event.currentTarget) close(); }}>
          <section ref={panelRef} tabIndex={-1} className={styles.sheet} role="dialog" aria-modal="true" aria-label={t("chat.turns")}>
            <header className={styles.header}>
              <strong>{t("chat.turns")}</strong>
              <div className={styles.headerActions}>
                <button type="button" aria-pressed={bookmarksOnly} onClick={() => setBookmarksOnly(value => !value)}>
                  <Bookmark size={UI_ICON_SIZE.inline} aria-hidden /> {t("chat.bookmarks")}
                </button>
                <button ref={closeRef} type="button" className={styles.close} onClick={close} aria-label={t("common.close")}>
                  <X size={UI_ICON_SIZE.control} aria-hidden />
                </button>
              </div>
            </header>
            <div className={styles.list}>
              {visibleTurns.length === 0 && <div className={styles.empty}>{t("chat.noTurns")}</div>}
              {visibleTurns.map(turn => {
                const number = turn.turnNumber ?? turns.indexOf(turn) + 1;
                const active = !bookmarksOnly && turns[current]?.visibleIndex === turn.visibleIndex;
                return (
                  <button key={turn.entryId ?? turn.visibleIndex} type="button" className={`${styles.turn} ${active ? styles.turnCurrent : ""}`} aria-current={active ? "true" : undefined}
                    onClick={() => {
                      if (onNavigate) onNavigate(turn.visibleIndex);
                      else messageRefs.current[turn.visibleIndex]?.scrollIntoView({ block: "start", behavior: motionScrollBehavior() });
                      close();
                    }}>
                    <span className={styles.number}>{number > 0 ? number : ""}</span>
                    <span className={styles.preview}>{turn.preview}</span>
                    {turn.bookmarked && <Bookmark className={styles.star} size={UI_ICON_SIZE.inline} aria-label={t("chat.bookmark")} />}
                  </button>
                );
              })}
            </div>
          </section>
        </div>, document.body,
      )}
    </>
  );
}
