"use client";

import { useState, useRef } from "react";
import { Columns2, Pin, X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { getFileIcon } from "../sidebar/FileIcons";
import { useI18n } from "@/lib/i18n";
import type { FileOpenIntent, FileViewState } from "@/lib/file-open";
import styles from "./TabBar.module.css";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  /** Line to jump to when opened from a search hit. */
  gotoLine?: number;
  /** Bumped each time the file is (re)opened at a line, to re-trigger the jump. */
  gotoNonce?: number;
  /** Canonical source/path/line/mode context for this open action. */
  intent?: FileOpenIntent;
  /** Per-tab reading state restored when switching between files. */
  viewState?: FileViewState;
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
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectTab(tab.id);
              }
            }}
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
            {tab.pinned && <span className={styles.pinned} aria-label={t("tabs.pinned")} title={t("tabs.pinned")}><Pin aria-hidden="true" /></span>}
            {splitTabId === tab.id && <span className={styles.splitMark} aria-label={t("tabs.openSplit")} title={t("tabs.openSplit")}><Columns2 aria-hidden="true" /></span>}
            <IconButton
              label={t("tabs.close")}
              icon={<X strokeWidth={1.8} />}
              size="compact"
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              className={styles.closeBtn}
            />
          </div>
        );
      })}

      {menu && (
        <>
          <div className={styles.menuBackdrop} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className={`glass ${styles.tabMenu}`} style={{ left: menu.x, top: menu.y }} role="menu">
            {onReveal && (
              <button type="button" role="menuitem" className={styles.tabMenuItem} onClick={() => { onReveal(menu.tab.filePath); setMenu(null); }}>
                {t("explorer.revealInTree")}
              </button>
            )}
            {onTogglePin && (
              <button type="button" role="menuitem" className={styles.tabMenuItem} onClick={() => { onTogglePin(menu.tab.id); setMenu(null); }}>
                {menu.tab.pinned ? t("tabs.unpin") : t("tabs.pin")}
              </button>
            )}
            {onOpenSplit && tabs.length > 1 && (
              <button type="button" role="menuitem" className={styles.tabMenuItem} onClick={() => { onOpenSplit(menu.tab.id); setMenu(null); }}>
                {splitTabId === menu.tab.id ? t("tabs.closeSplit") : t("tabs.openSplit")}
              </button>
            )}
            <button type="button" role="menuitem" className={styles.tabMenuItem} onClick={() => { onCloseTab(menu.tab.id); setMenu(null); }}>
              {t("tabs.close")}
            </button>
            {onCloseOthers && tabs.length > 1 && (
              <button type="button" role="menuitem" className={styles.tabMenuItem} onClick={() => { onCloseOthers(menu.tab.id); setMenu(null); }}>
                {t("tabs.closeOthers")}
              </button>
            )}
            {onCloseAll && (
              <button type="button" role="menuitem" className={styles.tabMenuItem} onClick={() => { onCloseAll(); setMenu(null); }}>
                {t("tabs.closeAll")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
