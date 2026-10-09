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

export const fileTabId = (id: string) => `file-tab-${encodeURIComponent(id)}`;
export const filePanelId = (id: string) => `file-panel-${encodeURIComponent(id)}`;

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onCloseOthers, onCloseAll, onReorder, onReveal, onTogglePin, onOpenSplit, splitTabId }: Props) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null);
  const dragId = useRef<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const closeTab = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const next = tabs[index + 1] ?? tabs[index - 1];
    const restoreFocus = document.activeElement === tabRefs.current.get(id)
      || (document.activeElement instanceof HTMLElement && document.activeElement.dataset.closeFileTab === id);
    onCloseTab(id);
    if (restoreFocus && next) {
      const focusId = activeTabId === id ? next.id : activeTabId;
      if (activeTabId === id) onSelectTab(focusId);
      requestAnimationFrame(() => tabRefs.current.get(focusId)?.focus());
    }
  };

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabList} role="tablist" aria-label={t("tabs.files")}>
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="presentation"
            data-file-tab={tab.id}
            draggable={!!onReorder}
            onDragStart={() => { dragId.current = tab.id; }}
            onDragOver={(e) => { if (dragId.current && dragId.current !== tab.id) e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId.current && dragId.current !== tab.id) onReorder?.(dragId.current, index);
              dragId.current = null;
            }}
            // Middle-click closes, like a browser tab.
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, tab }); }}
            className={`${styles.tab} ${isActive ? styles.tabActive : styles.tabInactive}`}
            style={{ gridColumn: index + 1, gridRow: 1 }}
          >
            <button
              type="button"
              ref={(node) => { if (node) tabRefs.current.set(tab.id, node); else tabRefs.current.delete(tab.id); }}
              className={styles.tabSelect}
              id={fileTabId(tab.id)}
              role="tab"
              aria-selected={isActive}
              aria-controls={filePanelId(tab.id)}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={(event) => {
                const nextIndex = event.key === "ArrowRight" ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
                  : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
                if (nextIndex === null) return;
                event.preventDefault();
                const next = tabs[nextIndex];
                onSelectTab(next.id);
                tabRefs.current.get(next.id)?.focus();
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
            </button>

          </div>
        );
      })}

      </div>
      {tabs.map((tab, index) => (
        <IconButton
          key={`close:${tab.id}`}
          data-close-file-tab={tab.id}
          label={t("tabs.close")}
          icon={<X strokeWidth={1.8} />}
          size="compact"
          onClick={() => closeTab(tab.id)}
          className={styles.closeBtn}
          style={{ gridColumn: index + 1, gridRow: 1 }}
        />
      ))}

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
