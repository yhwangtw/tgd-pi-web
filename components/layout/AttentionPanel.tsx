"use client";

import { useEffect, useMemo, useState } from "react";
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

function pushKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

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
  const [pushState, setPushState] = useState<"loading" | "enabled" | "disabled" | "unavailable">("loading");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushPublicKey, setPushPublicKey] = useState("");
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { setPushState("unavailable"); return; }
    let cancelled = false;
    Promise.all([
      fetch("/api/push", { cache: "no-store" }),
      navigator.serviceWorker.register("/pi-service-worker.js"),
    ]).then(async ([response, registration]) => {
      if (!response.ok) throw new Error(String(response.status));
      const config = await response.json() as { publicKey?: string };
      const subscription = await registration.pushManager.getSubscription();
      if (!cancelled) { setPushPublicKey(config.publicKey ?? ""); setPushState(subscription ? "enabled" : "disabled"); }
    }).catch(() => { if (!cancelled) setPushState("unavailable"); });
    return () => { cancelled = true; };
  }, []);
  const togglePush = async () => {
    if (pushBusy || pushState === "unavailable") return;
    setPushBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription();
      if (current) {
        await fetch("/api/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: current.endpoint }) });
        await current.unsubscribe(); setPushState("disabled");
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") { setPushState("disabled"); return; }
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKey(pushPublicKey) });
        const response = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subscription) });
        if (!response.ok) { await subscription.unsubscribe(); throw new Error(`HTTP ${response.status}`); }
        setPushState("enabled");
      }
    } catch { setPushState("unavailable"); }
    finally { setPushBusy(false); }
  };
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
          <button type="button" className={s.pushButton} onClick={() => void togglePush()} disabled={pushBusy || pushState === "loading" || pushState === "unavailable"} aria-pressed={pushState === "enabled"} title={pushState === "enabled" ? t("attention.pushDisable") : t("attention.pushEnable")}>♧</button>
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
