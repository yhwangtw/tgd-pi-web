"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "@/hooks/useModalDialog";
import {
  BarChart3,
  Bell,
  Bot,
  Box,
  CalendarDays,
  Cpu,
  Ellipsis,
  FileText,
  Folder,
  GitBranch,
  Layers3,
  List,
  MessageSquare,
  Palette,
  Puzzle,
  Search,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { PanelView } from "./IconRail";
import s from "./AppShell.module.css";

interface Props {
  panelView: PanelView;
  panelOpen: boolean;
  filePanelOpen: boolean;
  onShowChat: () => void;
  onSelectView: (view: PanelView) => void;
  onOpenAnalytics: () => void;
  onOpenModels: () => void;
  onOpenSkills: () => void;
  skillsDisabled: boolean;
  onOpenExtensions: () => void;
  onOpenAppearance: (returnFocus?: HTMLElement | null) => void;
  onOpenDesignMode?: () => void;
  attentionUnreadCount?: number;
}

interface NavButtonProps {
  buttonRef?: Ref<HTMLButtonElement>;
  active?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  expanded?: boolean;
  badge?: number;
}

function NavButton({ active, icon, label, onClick, expanded, buttonRef, badge = 0 }: NavButtonProps) {
  const { t } = useI18n();
  const badgeId = useId();
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`${s.mobileNavButton} ${active ? s.mobileNavButtonActive : ""}`}
      onClick={onClick}
      onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" })}
      aria-current={active ? "page" : undefined}
      aria-expanded={expanded}
      aria-describedby={badge > 0 ? badgeId : undefined}
    >
      <span className={s.mobileNavIcon} aria-hidden>
        {icon}
        {badge > 0 && <span className={s.mobileNavUnreadDot} data-testid="mobile-attention-unread-dot" />}
      </span>
      {badge > 0 && <span id={badgeId} hidden>{badge} {t("attention.unread")}</span>}
      <span>{label}</span>
    </button>
  );
}

interface MoreActionProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  badge?: number;
}

function MoreAction({ icon, label, onClick, disabled, active, badge }: MoreActionProps) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`${s.mobileMoreAction} ${active ? s.mobileMoreActionActive : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={badge ? `${label} · ${badge} ${t("attention.unread")}` : undefined}
    >
      <span aria-hidden>{icon}</span>
      <span className={s.mobileActionLabel}>
        <span>{label}</span>
        {badge ? <span className={s.mobileActionBadge} aria-hidden="true">{badge > 99 ? "99+" : badge}</span> : null}
      </span>
    </button>
  );
}

export function MobileNavigation({
  panelView,
  panelOpen,
  filePanelOpen,
  onShowChat,
  onSelectView,
  onOpenAnalytics,
  onOpenModels,
  onOpenSkills,
  skillsDisabled,
  onOpenExtensions,
  onOpenAppearance,
  onOpenDesignMode,
  attentionUnreadCount = 0,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const titleId = useId();
  const { panelRef } = useModalDialog<HTMLElement>({ open: moreOpen, onClose: closeMore, initialFocusRef: closeRef });
  const { t } = useI18n();
  const secondaryViewActive = panelOpen && ["attention", "agents", "schedule", "changes", "tgd"].includes(panelView);

  useEffect(() => {
    if (!moreOpen) return;
    const viewport = window.matchMedia("(max-width: 700px)");
    const closeOnDesktop = () => { if (!viewport.matches) closeMore(); };
    closeOnDesktop();
    viewport.addEventListener("change", closeOnDesktop);
    return () => viewport.removeEventListener("change", closeOnDesktop);
  }, [moreOpen, closeMore]);

  const run = (action: () => void) => {
    setMoreOpen(false);
    action();
  };

  return (
    <>
      <nav className={s.mobileNav} aria-label={t("navigation.primary")}>
        <NavButton
          active={!panelOpen && !filePanelOpen && !moreOpen}
          label={t("mobile.chat")}
          onClick={onShowChat}
          icon={<MessageSquare size={UI_ICON_SIZE.navigation} />}
        />
        <NavButton
          active={panelOpen && panelView === "sessions"}
          label={t("mobile.sessions")}
          onClick={() => onSelectView("sessions")}
          icon={<List size={UI_ICON_SIZE.navigation} />}
        />
        <NavButton
          active={panelOpen && panelView === "files"}
          label={t("mobile.files")}
          onClick={() => onSelectView("files")}
          icon={<Folder size={UI_ICON_SIZE.navigation} />}
        />
        <NavButton
          active={panelOpen && panelView === "search"}
          label={t("mobile.search")}
          onClick={() => onSelectView("search")}
          icon={<Search size={UI_ICON_SIZE.navigation} />}
        />
        <NavButton
          active={moreOpen || secondaryViewActive}
          buttonRef={moreRef}
          expanded={moreOpen}
          badge={attentionUnreadCount}
          label={t("mobile.more")}
          onClick={() => setMoreOpen(!moreOpen)}
          icon={<Ellipsis size={UI_ICON_SIZE.navigation} />}
        />
      </nav>

      {moreOpen && typeof document !== "undefined" && createPortal(
        <div data-dialog-root className={s.mobileMoreRoot}>
          <button type="button" className={s.mobileSheetBackdrop} tabIndex={-1}
            onClick={closeMore} aria-label={t("mobile.closeMore")} />
        <section ref={panelRef} className={s.mobileMoreSheet} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
          <div className={s.mobileSheetHandle} aria-hidden />
          <div className={s.mobileSheetHeader}>
            <strong id={titleId}>{t("mobile.moreActions")}</strong>
            <button ref={closeRef} type="button" onClick={closeMore} aria-label={t("mobile.closeMore")}><X size={UI_ICON_SIZE.control} aria-hidden="true" /></button>
          </div>
          <div className={s.mobileMoreGroup}>
            <div className={s.mobileMoreGroupTitle}>{t("mobile.work")}</div>
            <div className={s.mobileMoreGrid}>
              <MoreAction label={t("attention.title")} badge={attentionUnreadCount} active={panelOpen && panelView === "attention"} onClick={() => run(() => onSelectView("attention"))} icon={<Bell size={UI_ICON_SIZE.navigation} />} />
              <MoreAction label={t("agents.title")} active={panelOpen && panelView === "agents"} onClick={() => run(() => onSelectView("agents"))} icon={<Bot size={UI_ICON_SIZE.navigation} />} />
              <MoreAction label={t("schedule.title")} active={panelOpen && panelView === "schedule"} onClick={() => run(() => onSelectView("schedule"))} icon={<CalendarDays size={UI_ICON_SIZE.navigation} />} />
              <MoreAction label={t("mobile.changes")} active={panelOpen && panelView === "changes"} onClick={() => run(() => onSelectView("changes"))} icon={<GitBranch size={UI_ICON_SIZE.navigation} />} />
              <MoreAction label={t("tgd.artifacts")} active={panelOpen && panelView === "tgd"} onClick={() => run(() => onSelectView("tgd"))} icon={<FileText size={UI_ICON_SIZE.navigation} />} />
              <MoreAction label={t("topbar.analytics")} onClick={() => run(onOpenAnalytics)} icon={<BarChart3 size={UI_ICON_SIZE.navigation} />} />
            </div>
          </div>
          <div className={s.mobileMoreGroup}>
            <div className={s.mobileMoreGroupTitle}>{t("mobile.settings")}</div>
            <div className={s.mobileMoreGrid}>
              <MoreAction label={t("sidebar.models")} onClick={() => run(onOpenModels)} icon={<Cpu size={UI_ICON_SIZE.navigation} />} />
              <MoreAction label={t("sidebar.skills")} disabled={skillsDisabled} onClick={() => run(onOpenSkills)} icon={<Layers3 size={UI_ICON_SIZE.navigation} />} />
              <MoreAction label={t("extensions.title")} onClick={() => run(onOpenExtensions)} icon={<Puzzle size={UI_ICON_SIZE.navigation} />} />
              <MoreAction label={t("appearance.title")} onClick={() => run(() => onOpenAppearance(moreRef.current))} icon={<Palette size={UI_ICON_SIZE.navigation} />} />
              {onOpenDesignMode && <MoreAction label={t("topbar.designMode")} onClick={() => run(() => onOpenDesignMode())} icon={<Box size={UI_ICON_SIZE.navigation} />} />}
            </div>
          </div>
        </section>
        </div>, document.body,
      )}
    </>
  );
}
