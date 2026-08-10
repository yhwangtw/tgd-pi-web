"use client";

import { useState, useRef } from "react";
import { getFileIcon } from "../sidebar/FileIcons";
import { useI18n } from "@/lib/i18n";
import styles from "./TabBar.module.css";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  /** Line to jump to when opened from a search hit. */
  gotoLine?: number;
  /** Bumped each time the file is (re)opened at a line, to re-trigger the jump. */
  gotoNonce?: number;
  pinned?: boolean;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Close every tab except this one. */
  onCloseOthers?: (id: string) => void;
  /** Close all tabs. */
  onCloseAll?: () => void;
  /** Reorder: move the tab with `id` to `toIndex`. */
  onReorder?: (id: string, toIndex: number) => void;
  /** Reveal a tab's file in the explorer. */
  onReveal?: (filePath: string) => void;
  onTogglePin?: (id: string) => void;
  onOpenSplit?: (id: string) => void;
  splitTabId?: string | null;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onCloseOthers, onCloseAll, onReorder, onReveal, onTogglePin, onOpenSplit, splitTabId }: Props) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null);
  const dragId = useRef<string | null>(null);

  return (
    <div className={styles.tabBar}>
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            draggable={!!onReorder}
            onDragStart={() => { dragId.current = tab.id; }}
            onDragOver={(e) => { if (dragId.current && dragId.current !== tab.id) e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId.current && dragId.current !== tab.id) onReorder?.(dragId.current, index);
              dragId.current = null;
            }}
            onClick={() => onSelectTab(tab.id)}
            // Middle-click closes, like a browser tab.
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseTab(tab.id); } }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, tab }); }}
            className={`${styles.tab} ${isActive ? styles.tabActive : styles.tabInactive}`}
          >
            <span className={`${styles.tabIcon} ${isActive ? styles.tabIconActive : styles.tabIconInactive}`}>
              {getFileIcon(tab.label, 13)}
            </span>
            <span
              className={`${styles.tabLabel} ${isActive ? styles.tabLabelActive : styles.tabLabelInactive}`}
              title={tab.filePath}
            >
              {tab.label}
            </span>
            {tab.pinned && <span className={styles.pinned} aria-label="Pinned" title="Pinned">●</span>}
            {splitTabId === tab.id && <span className={styles.splitMark} aria-label="Open in split" title="Open in split">Ⅱ</span>}
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              className={`bg-none text-dim hover-bg-text ${styles.closeBtn}`}
              title="Close"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}

      {menu && (
        <>
          <div className={styles.menuBackdrop} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className={`glass ${styles.tabMenu}`} style={{ left: menu.x, top: menu.y }} role="menu">
            {onReveal && (
              <button className={styles.tabMenuItem} onClick={() => { onReveal(menu.tab.filePath); setMenu(null); }}>
                {t("explorer.revealInTree")}
              </button>
            )}
            {onTogglePin && (
              <button className={styles.tabMenuItem} onClick={() => { onTogglePin(menu.tab.id); setMenu(null); }}>
                {menu.tab.pinned ? "Unpin tab" : "Pin tab"}
              </button>
            )}
            {onOpenSplit && tabs.length > 1 && (
              <button className={styles.tabMenuItem} onClick={() => { onOpenSplit(menu.tab.id); setMenu(null); }}>
                {splitTabId === menu.tab.id ? "Close split" : "Open in split"}
              </button>
            )}
            <button className={styles.tabMenuItem} onClick={() => { onCloseTab(menu.tab.id); setMenu(null); }}>
              {t("tabs.close")}
            </button>
            {onCloseOthers && tabs.length > 1 && (
              <button className={styles.tabMenuItem} onClick={() => { onCloseOthers(menu.tab.id); setMenu(null); }}>
                {t("tabs.closeOthers")}
              </button>
            )}
            {onCloseAll && (
              <button className={styles.tabMenuItem} onClick={() => { onCloseAll(); setMenu(null); }}>
                {t("tabs.closeAll")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
