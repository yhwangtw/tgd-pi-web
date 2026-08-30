"use client";

import { useEffect, useState, type ReactNode } from "react";
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
  onOpenAppearance: () => void;
  onOpenDesignMode?: () => void;
  attentionUnreadCount?: number;
}

interface NavButtonProps {
  active?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  expanded?: boolean;
}

function NavButton({ active, icon, label, onClick, expanded }: NavButtonProps) {
  return (
    <button
      type="button"
      className={`${s.mobileNavButton} ${active ? s.mobileNavButtonActive : ""}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-expanded={expanded}
    >
      <span className={s.mobileNavIcon} aria-hidden>{icon}</span>
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
  return (
    <button
      type="button"
      className={`${s.mobileMoreAction} ${active ? s.mobileMoreActionActive : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span aria-hidden>{icon}</span>
      <span>{label}</span>
      {badge ? <span className={s.mobileActionBadge}>{Math.min(badge, 99)}</span> : null}
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
  const { t } = useI18n();
  const secondaryViewActive = panelOpen && ["attention", "agents", "schedule", "changes", "tgd"].includes(panelView);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [moreOpen]);

  const run = (action: () => void) => {
    setMoreOpen(false);
    action();
  };

  return (
    <>
      {moreOpen && (
        <button
          type="button"
          className={s.mobileSheetBackdrop}
          onClick={() => setMoreOpen(false)}
          aria-label={t("mobile.closeMore")}
        />
      )}
      <nav className={s.mobileNav} aria-label={t("navigation.primary")}>
        <NavButton
          active={!panelOpen && !filePanelOpen && !moreOpen}
          label={t("mobile.chat")}
          onClick={onShowChat}
          icon={<MessageSquare size={20} strokeWidth={1.8} />}
        />
        <NavButton
          active={panelOpen && panelView === "sessions"}
          label={t("mobile.sessions")}
          onClick={() => onSelectView("sessions")}
          icon={<List size={20} strokeWidth={1.8} />}
        />
        <NavButton
          active={panelOpen && panelView === "files"}
          label={t("mobile.files")}
          onClick={() => onSelectView("files")}
          icon={<Folder size={20} strokeWidth={1.8} />}
        />
        <NavButton
          active={panelOpen && panelView === "search"}
          label={t("mobile.search")}
          onClick={() => onSelectView("search")}
          icon={<Search size={20} strokeWidth={1.8} />}
        />
        <NavButton
          active={moreOpen || secondaryViewActive}
          expanded={moreOpen}
          label={t("mobile.more")}
          onClick={() => setMoreOpen(!moreOpen)}
          icon={<Ellipsis size={20} strokeWidth={1.8} />}
        />
      </nav>

      {moreOpen && (
        <section className={s.mobileMoreSheet} aria-label={t("mobile.moreActions")}>
          <div className={s.mobileSheetHandle} aria-hidden />
          <div className={s.mobileSheetHeader}>
            <strong>{t("mobile.moreActions")}</strong>
            <button type="button" onClick={() => setMoreOpen(false)} aria-label={t("mobile.closeMore")}><X size={18} strokeWidth={2} aria-hidden="true" /></button>
          </div>
          <div className={s.mobileMoreGroup}>
            <div className={s.mobileMoreGroupTitle}>{t("mobile.work")}</div>
            <div className={s.mobileMoreGrid}>
              <MoreAction label={t("attention.title")} badge={attentionUnreadCount} active={panelOpen && panelView === "attention"} onClick={() => run(() => onSelectView("attention"))} icon={<Bell size={20} strokeWidth={1.8} />} />
              <MoreAction label={t("agents.title")} active={panelOpen && panelView === "agents"} onClick={() => run(() => onSelectView("agents"))} icon={<Bot size={20} strokeWidth={1.8} />} />
              <MoreAction label={t("schedule.title")} active={panelOpen && panelView === "schedule"} onClick={() => run(() => onSelectView("schedule"))} icon={<CalendarDays size={20} strokeWidth={1.8} />} />
              <MoreAction label={t("mobile.changes")} active={panelOpen && panelView === "changes"} onClick={() => run(() => onSelectView("changes"))} icon={<GitBranch size={20} strokeWidth={1.8} />} />
              <MoreAction label={t("tgd.artifacts")} active={panelOpen && panelView === "tgd"} onClick={() => run(() => onSelectView("tgd"))} icon={<FileText size={20} strokeWidth={1.8} />} />
              <MoreAction label={t("topbar.analytics")} onClick={() => run(onOpenAnalytics)} icon={<BarChart3 size={20} strokeWidth={1.8} />} />
            </div>
          </div>
          <div className={s.mobileMoreGroup}>
            <div className={s.mobileMoreGroupTitle}>{t("mobile.settings")}</div>
            <div className={s.mobileMoreGrid}>
              <MoreAction label={t("sidebar.models")} onClick={() => run(onOpenModels)} icon={<Cpu size={20} strokeWidth={1.8} />} />
              <MoreAction label={t("sidebar.skills")} disabled={skillsDisabled} onClick={() => run(onOpenSkills)} icon={<Layers3 size={20} strokeWidth={1.8} />} />
              <MoreAction label={t("extensions.title")} onClick={() => run(onOpenExtensions)} icon={<Puzzle size={20} strokeWidth={1.8} />} />
              <MoreAction label={t("appearance.title")} onClick={() => run(onOpenAppearance)} icon={<Palette size={20} strokeWidth={1.8} />} />
              {onOpenDesignMode && <MoreAction label={t("topbar.designMode")} onClick={() => run(() => onOpenDesignMode())} icon={<Box size={20} strokeWidth={1.8} />} />}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
