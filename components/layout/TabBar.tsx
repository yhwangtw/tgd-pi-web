"use client";

import { useState, useRef, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Columns2, Pin, X } from "lucide-react";
import { ActionMenu, ActionMenuRadioGroup, ActionMenuRadioItem } from "@/components/ui/ActionMenu";
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
  const [menu, setMenu] = useState<{ offsetX: number; offsetY: number; tab: Tab } | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const [fileListOpen, setFileListOpen] = useState(false);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const updateOverflow = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    const next = { left: max > 1 && strip.scrollLeft > 1, right: max > 1 && strip.scrollLeft < max - 1 };
    setOverflow(previous => previous.left === next.left && previous.right === next.right ? previous : next);
  }, []);
  const scrollTabs = (direction: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.scrollLeft = Math.max(0, Math.min(strip.scrollWidth - strip.clientWidth,
      strip.scrollLeft + direction * Math.max(80, strip.clientWidth * 0.75)));
    updateOverflow();
  };
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const active = tabRefs.current.get(activeTabId)?.closest<HTMLElement>("[data-file-tab]");
    if (!strip || !active) return;
    const revealActive = () => {
      const viewport = strip.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      // Scroll only this strip; opening a file must not move the chat/page.
      if (tab.width > viewport.width || tab.left < viewport.left) strip.scrollLeft += tab.left - viewport.left;
      else if (tab.right > viewport.right) strip.scrollLeft += tab.right - viewport.right;
      updateOverflow();
    };
    revealActive();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(revealActive) : null;
    observer?.observe(strip);
    const wheel = (event: WheelEvent) => {
      // Regular mouse wheels can reach offscreen tabs; keep trackpad and zoom native.
      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1;
      const before = strip.scrollLeft;
      strip.scrollLeft = Math.max(0, Math.min(strip.scrollWidth - strip.clientWidth, before + event.deltaY * unit));
      if (strip.scrollLeft !== before) event.preventDefault();
      updateOverflow();
    };
    strip.addEventListener("scroll", updateOverflow, { passive: true });
    strip.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer?.disconnect();
      strip.removeEventListener("scroll", updateOverflow);
      strip.removeEventListener("wheel", wheel);
    };
  }, [activeTabId, tabs, updateOverflow]);

  const dismissMenu = useCallback((restoreFocus = true) => {
    if (restoreFocus && menu) tabRefs.current.get(menu.tab.id)?.focus({ preventScroll: true });
    setMenu(null);
  }, [menu]);

  const openMenu = (tab: Tab, point?: { x: number; y: number }) => {
    const anchor = tabRefs.current.get(tab.id)?.getBoundingClientRect();
    if (!anchor) return;
    setFileListOpen(false);
    setMenu({ tab, offsetX: point ? point.x - anchor.left : 0, offsetY: point ? point.y - anchor.top : anchor.height });
  };

  useLayoutEffect(() => {
    if (!menu) return;
    const update = () => {
      const anchor = tabRefs.current.get(menu.tab.id);
      const content = menuRef.current;
      if (!anchor || !content || anchor.closest('[inert], [aria-hidden="true"]')) {
        setMenu(null);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 8;
      const top = (viewport?.offsetTop ?? 0) + 8;
      const right = left + (viewport?.width ?? window.innerWidth) - 16;
      const bottom = top + (viewport?.height ?? window.innerHeight) - 16;
      const size = content.getBoundingClientRect();
      const next = {
        left: Math.max(left, Math.min(rect.left + menu.offsetX, right - size.width)),
        top: Math.max(top, Math.min(rect.top + menu.offsetY, bottom - size.height)),
      };
      setMenuPosition(previous => previous.left === next.left && previous.top === next.top ? previous : next);
    };
    update();
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (menuRef.current) observer?.observe(menuRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [menu]);

  const closeTab = (id: string, fromMenu = false) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const next = tabs[index + 1] ?? tabs[index - 1];
    const restoreFocus = fromMenu || document.activeElement === tabRefs.current.get(id)
      || (document.activeElement instanceof HTMLElement && document.activeElement.dataset.closeFileTab === id);
    onCloseTab(id);
    if (restoreFocus && next) {
      const focusId = activeTabId === id ? next.id : activeTabId;
      if (activeTabId === id) onSelectTab(focusId);
      requestAnimationFrame(() => tabRefs.current.get(focusId)?.focus());
    }
  };

  return (
    <div className={styles.container}>
    <div ref={stripRef} className={styles.tabBar} data-testid="file-tab-strip">
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
            onDragEnd={() => { dragId.current = null; }}
            onDragOver={(e) => { if (dragId.current && dragId.current !== tab.id) e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId.current && dragId.current !== tab.id) onReorder?.(dragId.current, index);
              dragId.current = null;
            }}
            // Prevent Windows auto-scroll before closing on middle-click.
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } }}
            onContextMenu={(event) => {
              event.preventDefault();
              openMenu(tab, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
            }}
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
              aria-haspopup="menu"
              aria-expanded={menu?.tab.id === tab.id}
              aria-keyshortcuts="Shift+F10"
              tabIndex={isActive ? 0 : -1}
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  openMenu(tab);
                  return;
                }
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
                {getFileIcon(tab.label)}
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
      {/* Share each tab’s grid cell visually, but keep close buttons outside
          the ARIA tablist and its tab buttons. */}
      {tabs.map((tab, index) => (
        <button
          key={`close:${tab.id}`}
          type="button"
          data-close-file-tab={tab.id}
          aria-label={`${t("tabs.close")}: ${tab.label}`}
          title={`${t("tabs.close")}: ${tab.label}`}
          onClick={() => closeTab(tab.id)}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } }}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu(tab, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
          }}
          className={styles.closeBtn}
          style={{ gridColumn: index + 1, gridRow: 1 }}
        >
          <X aria-hidden="true" />
        </button>
      ))}

    </div>
    {tabs.length > 1 && <div className={styles.navigation}>
      {(overflow.left || overflow.right) && <>
        <button type="button" className={styles.navigationButton} disabled={!overflow.left}
          aria-label={t("tabs.scrollLeft")} title={t("tabs.scrollLeft")} onClick={() => scrollTabs(-1)}>
          <ChevronLeft aria-hidden="true" />
        </button>
        <button type="button" className={styles.navigationButton} disabled={!overflow.right}
          aria-label={t("tabs.scrollRight")} title={t("tabs.scrollRight")} onClick={() => scrollTabs(1)}>
          <ChevronRight aria-hidden="true" />
        </button>
      </>}
      <ActionMenu open={fileListOpen} onOpenChange={open => { setFileListOpen(open); if (open) setMenu(null); }}
        label={t("tabs.files")} trigger={
          <button type="button" className={`${styles.navigationButton} ${styles.allTabsButton}`}
            aria-label={t("tabs.showAll")} title={t("tabs.showAll")}>
            <span aria-hidden="true">{tabs.length}</span><ChevronDown aria-hidden="true" />
          </button>
        }>
        <ActionMenuRadioGroup value={activeTabId} onValueChange={id => { onSelectTab(id); setFileListOpen(false); }}>
          {tabs.map(tab => <ActionMenuRadioItem key={tab.id} value={tab.id}>
            <span className={styles.tabIcon}>{getFileIcon(tab.label)}</span>
            <span className={styles.fileOption} title={tab.filePath}>
              <span className={styles.fileOptionName}>{tab.label}</span>
              <span className={styles.fileOptionPath}>{tab.filePath}</span>
            </span>
            <span className={styles.selectionMark} aria-hidden="true">{tab.id === activeTabId && <Check />}</span>
          </ActionMenuRadioItem>)}
        </ActionMenuRadioGroup>
      </ActionMenu>
    </div>}

      {menu && createPortal(
        <>
          <div className={styles.menuBackdrop} onPointerDown={(event) => { event.preventDefault(); dismissMenu(); }} onContextMenu={(event) => { event.preventDefault(); dismissMenu(); }} />
          <div ref={menuRef} className={`glass ${styles.tabMenu}`} style={menuPosition} role="menu" aria-label={menu.tab.label}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault(); event.stopPropagation(); dismissMenu(); return;
              }
              if (event.key === "Tab") {
                event.preventDefault(); event.stopPropagation();
                const anchor = tabRefs.current.get(menu.tab.id);
                const focusable = Array.from(document.querySelectorAll<HTMLElement>(
                  'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]',
                )).filter(node => node.tabIndex >= 0 && !event.currentTarget.contains(node)
                  && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden"
                  && !node.closest('[inert],[aria-hidden="true"]'));
                const index = anchor ? focusable.indexOf(anchor) : -1;
                const target = index >= 0 ? focusable[index + (event.shiftKey ? -1 : 1)] : anchor;
                dismissMenu(false);
                (target ?? anchor)?.focus({ preventScroll: true });
                return;
              }
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              const index = event.key === "ArrowDown" ? (current + 1) % items.length
                : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length
                : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
              if (index !== null) { event.preventDefault(); event.stopPropagation(); items[index]?.focus(); }
            }}>
            {onReveal && (
              <button type="button" role="menuitem" tabIndex={-1} className={styles.tabMenuItem} onClick={() => { dismissMenu(); onReveal(menu.tab.filePath); }}>
                {t("explorer.revealInTree")}
              </button>
            )}
            {onTogglePin && (
              <button type="button" role="menuitem" tabIndex={-1} className={styles.tabMenuItem} onClick={() => { dismissMenu(); onTogglePin(menu.tab.id); }}>
                {menu.tab.pinned ? t("tabs.unpin") : t("tabs.pin")}
              </button>
            )}
            {onOpenSplit && tabs.length > 1 && (
              <button type="button" role="menuitem" tabIndex={-1} className={styles.tabMenuItem} onClick={() => { dismissMenu(); onOpenSplit(menu.tab.id); }}>
                {splitTabId === menu.tab.id ? t("tabs.closeSplit") : t("tabs.openSplit")}
              </button>
            )}
            <button type="button" role="menuitem" tabIndex={-1} className={styles.tabMenuItem} onClick={() => { closeTab(menu.tab.id, true); dismissMenu(false); }}>
              {t("tabs.close")}
            </button>
            {onCloseOthers && tabs.length > 1 && (
              <button type="button" role="menuitem" tabIndex={-1} className={styles.tabMenuItem} onClick={() => { dismissMenu(); onCloseOthers(menu.tab.id); }}>
                {t("tabs.closeOthers")}
              </button>
            )}
            {onCloseAll && (
              <button type="button" role="menuitem" tabIndex={-1} className={styles.tabMenuItem} onClick={() => { dismissMenu(false); onCloseAll(); }}>
                {t("tabs.closeAll")}
              </button>
            )}
          </div>
        </>, document.body
      )}
    </div>
  );
}
