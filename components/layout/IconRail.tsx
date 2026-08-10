"use client";

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
    <nav className={s.rail} aria-label="Primary">
      <button
        onClick={() => onSelectView("sessions")}
        title={t("sidebar.sessions")}
        aria-label={t("sidebar.sessions")}
        aria-pressed={panelView === "sessions" && sidebarOpen}
        className={`${s.railButton} ${panelView === "sessions" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>
      <button
        onClick={() => onSelectView("attention")}
        title={t("attention.title")}
        aria-label={`${t("attention.title")}${attentionUnreadCount > 0 ? ` · ${attentionUnreadCount}` : ""}`}
        aria-pressed={panelView === "attention" && sidebarOpen}
        className={`${s.railButton} ${panelView === "attention" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" />
        </svg>
        {attentionUnreadCount > 0 && <span className={s.railBadge}>{Math.min(attentionUnreadCount, 99)}</span>}
      </button>
      <button
        onClick={() => onSelectView("agents")}
        title={t("agents.title")}
        aria-label={t("agents.title")}
        aria-pressed={panelView === "agents" && sidebarOpen}
        className={`${s.railButton} ${panelView === "agents" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6M9 13h4" />
          <path d="M8 2v2M16 2v2M8 20v2M16 20v2M2 8h2M20 8h2M2 16h2M20 16h2" />
        </svg>
      </button>
      <button
        onClick={() => onSelectView("schedule")}
        title={t("schedule.title")}
        aria-label={t("schedule.title")}
        aria-pressed={panelView === "schedule" && sidebarOpen}
        className={`${s.railButton} ${panelView === "schedule" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" />
          <path d="M12 13v3l2 1" />
        </svg>
      </button>
      <button
        onClick={() => onSelectView("files")}
        title={t("sidebar.explorer")}
        aria-label={t("sidebar.explorer")}
        aria-pressed={panelView === "files" && sidebarOpen}
        className={`${s.railButton} ${panelView === "files" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      </button>
      <button
        onClick={() => onSelectView("search")}
        title={t("search.title")}
        aria-label={t("search.title")}
        aria-pressed={panelView === "search" && sidebarOpen}
        className={`${s.railButton} ${panelView === "search" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" />
        </svg>
      </button>
      <button
        onClick={() => onSelectView("changes")}
        title={t("mobile.changes")}
        aria-label={t("mobile.changes")}
        aria-pressed={panelView === "changes" && sidebarOpen}
        className={`${s.railButton} ${panelView === "changes" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      </button>
      <button
        onClick={() => onSelectView("tgd")}
        title={t("tgd.artifacts")}
        aria-label={t("tgd.artifacts")}
        aria-pressed={panelView === "tgd" && sidebarOpen}
        className={`${s.railButton} ${panelView === "tgd" && sidebarOpen ? s.railButtonActive : ""}`}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
          <line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" />
        </svg>
      </button>
      <button onClick={onOpenAnalytics} title={t("topbar.analyticsTitle")} className={s.railButton}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      </button>
      <div className={s.railSpacer} />
      <button onClick={onOpenModels} title={`${t("sidebar.models")} (⇧⌘M)`} className={s.railButton}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
          <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
          <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
        </svg>
      </button>
      <button
        onClick={onOpenSkills}
        disabled={skillsDisabled}
        title={`${t("sidebar.skills")} (⌘/)`}
        className={s.railButton}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
        </svg>
      </button>
      <button
        onClick={onOpenExtensions}
        title={t("extensions.title")}
        aria-label={t("extensions.title")}
        className={s.railButton}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z" />
        </svg>
      </button>
      <button
        onClick={onToggleAppearance}
        title={t("appearance.title")}
        aria-pressed={appearanceOpen}
        className={`${s.railButton} ${appearanceOpen ? s.railButtonActive : ""}`}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="13.5" cy="6.5" r="0.6" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r="0.6" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r="0.6" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r="0.6" fill="currentColor" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
        </svg>
      </button>
    </nav>
  );
}
