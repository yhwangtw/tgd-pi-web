"use client";

import { useMemo, useState } from "react";
import type { AttentionItem } from "@/lib/attention-center";
import { useI18n } from "@/lib/i18n";
import s from "./AttentionPanel.module.css";

type Filter = "all" | "unread" | "waiting" | "failed";

interface Props {
  items: AttentionItem[];
  readIds: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onOpenSession: (sessionId: string) => void | Promise<void>;
  onOpenSource: (source: "agent" | "schedule") => void;
}

const FILTERS: Filter[] = ["all", "unread", "waiting", "failed"];

export function AttentionPanel({
  items,
  readIds,
  loading,
  error,
  onRefresh,
  onMarkRead,
  onMarkAllRead,
  onOpenSession,
  onOpenSource,
}: Props) {
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState<Filter>("all");
  const unreadCount = items.reduce((count, item) => count + (readIds.has(item.id) ? 0 : 1), 0);
  const visibleItems = useMemo(() => items.filter((item) => {
    if (filter === "unread") return !readIds.has(item.id);
    if (filter === "waiting") return item.status === "waiting_for_input";
    if (filter === "failed") return item.status !== "waiting_for_input";
    return true;
  }), [filter, items, readIds]);

  const open = async (item: AttentionItem) => {
    onMarkRead(item.id);
    if (item.sessionId) {
      await onOpenSession(item.sessionId);
      return;
    }
    if (item.source === "agent" || item.source === "schedule") onOpenSource(item.source);
  };

  return (
    <section className={s.root} aria-label={t("attention.title")}>
      <header className={s.header}>
        <div>
          <strong>{t("attention.title")}</strong>
          <span>{unreadCount > 0 ? `${unreadCount} ${t("attention.unread")}` : t("attention.caughtUp")}</span>
        </div>
        <div className={s.headerActions}>
          <button type="button" onClick={onRefresh} disabled={loading} aria-label={t("attention.refresh")}>↻</button>
          <button type="button" onClick={onMarkAllRead} disabled={unreadCount === 0}>{t("attention.markAllRead")}</button>
        </div>
      </header>
      <div className={s.filters} aria-label={t("attention.filters")}>
        {FILTERS.map((item) => (
          <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)}>
            {t(`attention.filter.${item}`)}
          </button>
        ))}
      </div>
      {error && <div className={s.error} role="alert">{error}</div>}
      <div className={s.list} aria-busy={loading}>
        {loading && items.length === 0 ? (
          <div className={s.empty}>{t("common.loading")}</div>
        ) : visibleItems.length === 0 ? (
          <div className={s.empty}>
            <span aria-hidden>✓</span>
            <strong>{t("attention.empty")}</strong>
            <p>{t("attention.emptyHint")}</p>
          </div>
        ) : visibleItems.map((item) => {
          const read = readIds.has(item.id);
          const sourceLabel = item.source === "agent"
            ? t("agents.title")
            : item.source === "schedule"
              ? t("schedule.title")
              : t("attention.session");
          const time = new Intl.DateTimeFormat(locale === "zh" ? "zh-TW" : "en", {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          }).format(new Date(item.occurredAt));
          return (
            <article key={item.id} className={`${s.card} ${read ? s.cardRead : ""}`} data-severity={item.severity}>
              <div className={s.cardTop}>
                <span className={s.source}>{sourceLabel}</span>
                <time dateTime={item.occurredAt}>{time}</time>
                {!read && <i className={s.unreadDot} aria-label={t("attention.unreadItem")} />}
              </div>
              <strong className={s.title}>{item.title}</strong>
              <p className={s.summary}>{item.summary}</p>
              {item.cwd && <div className={`${s.path} chrome-mono`} title={item.cwd}>{item.cwd}</div>}
              <div className={s.actions}>
                <button type="button" onClick={() => void open(item)}>
                  {item.sessionId ? t("attention.openSession") : t("attention.openSource")}
                </button>
                {!read && <button type="button" className={s.secondary} onClick={() => onMarkRead(item.id)}>{t("attention.markRead")}</button>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
