"use client";

import {
  BarChart3,
  Bell,
  Bot,
  CalendarClock,
  Cpu,
  FileText,
  Folder,
  GitBranch,
  Layers3,
  MessageSquare,
  Palette,
  Puzzle,
  Search,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import s from "./AppShell.module.css";

export type PanelView = "sessions" | "attention" | "agents" | "schedule" | "files" | "search" | "changes" | "tgd";

interface IconRailProps {
  panelView: PanelView;
  sidebarOpen: boolean;
  onSelectView: (view: PanelView) => void;
  onOpenAnalytics: () => void;
  onOpenModels: () => void;
  onOpenSkills: () => void;
  skillsDisabled: boolean;
  onOpenExtensions: () => void;
  appearanceOpen: boolean;
  attentionUnreadCount?: number;
  onToggleAppearance: () => void;
}

/**
 * Left icon rail — global navigation, always visible. Pure presentation:
 * every click is delegated to the parent. Theme, language, typography, and
 * density intentionally live together in the Appearance panel.
 */
export function IconRail({
  panelView,
  sidebarOpen,
  onSelectView,
  onOpenAnalytics,
  onOpenModels,
  onOpenSkills,
  skillsDisabled,
  onOpenExtensions,
  appearanceOpen,
  attentionUnreadCount = 0,
  onToggleAppearance,
}: IconRailProps) {
  const { t } = useI18n();

  return (
    <nav className={s.rail} aria-label={t("navigation.primary")}>
      <button
        onClick={() => onSelectView("sessions")}
        title={t("sidebar.sessions")}
        aria-label={t("sidebar.sessions")}
        aria-pressed={panelView === "sessions" && sidebarOpen}
        className={`${s.railButton} ${panelView === "sessions" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <MessageSquare size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        onClick={() => onSelectView("attention")}
        title={t("attention.title")}
        aria-label={`${t("attention.title")}${attentionUnreadCount > 0 ? ` · ${attentionUnreadCount}` : ""}`}
        aria-pressed={panelView === "attention" && sidebarOpen}
        className={`${s.railButton} ${panelView === "attention" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <Bell size={17} strokeWidth={1.8} aria-hidden="true" />
        {attentionUnreadCount > 0 && <span className={s.railBadge}>{Math.min(attentionUnreadCount, 99)}</span>}
      </button>
      <button
        onClick={() => onSelectView("agents")}
        title={t("agents.title")}
        aria-label={t("agents.title")}
        aria-pressed={panelView === "agents" && sidebarOpen}
        className={`${s.railButton} ${panelView === "agents" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <Bot size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        onClick={() => onSelectView("schedule")}
        title={t("schedule.title")}
        aria-label={t("schedule.title")}
        aria-pressed={panelView === "schedule" && sidebarOpen}
        className={`${s.railButton} ${panelView === "schedule" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <CalendarClock size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        onClick={() => onSelectView("files")}
        title={t("sidebar.explorer")}
        aria-label={t("sidebar.explorer")}
        aria-pressed={panelView === "files" && sidebarOpen}
        className={`${s.railButton} ${panelView === "files" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <Folder size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        onClick={() => onSelectView("search")}
        title={t("search.title")}
        aria-label={t("search.title")}
        aria-pressed={panelView === "search" && sidebarOpen}
        className={`${s.railButton} ${panelView === "search" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <Search size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        onClick={() => onSelectView("changes")}
        title={t("mobile.changes")}
        aria-label={t("mobile.changes")}
        aria-pressed={panelView === "changes" && sidebarOpen}
        className={`${s.railButton} ${panelView === "changes" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <GitBranch size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        onClick={() => onSelectView("tgd")}
        title={t("tgd.artifacts")}
        aria-label={t("tgd.artifacts")}
        aria-pressed={panelView === "tgd" && sidebarOpen}
        className={`${s.railButton} ${panelView === "tgd" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <FileText size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button onClick={onOpenAnalytics} title={t("topbar.analyticsTitle")} aria-label={t("topbar.analyticsTitle")} className={s.railButton}>
        <BarChart3 size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <div className={s.railSpacer} />
      <button onClick={onOpenModels} title={`${t("sidebar.models")} (⇧⌘M)`} aria-label={t("sidebar.models")} className={s.railButton}>
        <Cpu size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        onClick={onOpenSkills}
        disabled={skillsDisabled}
        title={`${t("sidebar.skills")} (⌘/)`}
        aria-label={t("sidebar.skills")}
        className={s.railButton}
      >
        <Layers3 size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        onClick={onOpenExtensions}
        title={t("extensions.title")}
        aria-label={t("extensions.title")}
        className={s.railButton}
      >
        <Puzzle size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        onClick={onToggleAppearance}
        title={t("appearance.title")}
        aria-label={t("appearance.title")}
        aria-pressed={appearanceOpen}
        className={`${s.railButton} ${appearanceOpen ? s.railButtonActive : ""}`}
      >
        <Palette size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </nav>
  );
}
