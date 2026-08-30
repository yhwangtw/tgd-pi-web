"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Bell, BellRing, Check, CheckCheck, CircleCheckBig, RefreshCw, Trash2 } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import type { AttentionItem } from "@/lib/attention-center";
import { useI18n } from "@/lib/i18n";
import s from "./AttentionPanel.module.css";

type Filter = "all" | "unread" | "waiting" | "failed" | "completed";
type GroupKey = "needsInput" | "failed" | "completed";

interface Props {
  items: AttentionItem[];
  readIds: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onClearCompleted: (ids: string[]) => void;
  onOpenSession: (sessionId: string) => void | Promise<void>;
  onOpenSource: (source: "agent" | "schedule") => void;
}

const FILTERS: Filter[] = ["all", "unread", "waiting", "failed", "completed"];

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
  onClearCompleted,
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
    if (filter === "failed") return item.status === "failed" || item.status === "interrupted";
    if (filter === "completed") return item.status === "completed";
    return true;
  }), [filter, items, readIds]);
  const groups = useMemo(() => {
    const groupItems: Array<{ key: GroupKey; items: AttentionItem[] }> = [
      { key: "needsInput", items: visibleItems.filter((item) => item.status === "waiting_for_input") },
      { key: "failed", items: visibleItems.filter((item) => item.status === "failed" || item.status === "interrupted") },
      { key: "completed", items: visibleItems.filter((item) => item.status === "completed") },
    ];
    return groupItems.filter((group) => group.items.length > 0);
  }, [visibleItems]);

  const open = async (item: AttentionItem) => {
    onMarkRead(item.id);
    if (item.sessionId) {
      await onOpenSession(item.sessionId);
      return;
    }
    if (item.source === "agent" || item.source === "schedule") onOpenSource(item.source);
  };

  const renderItem = (item: AttentionItem) => {
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
      <article key={item.id} className={`${s.card} ${read ? s.cardRead : ""}`} data-severity={item.severity} data-status={item.status}>
        <div className={s.cardTop}>
          <span className={s.source}>{sourceLabel}</span>
          <time dateTime={item.occurredAt}>{time}</time>
          {!read && <i className={s.unreadDot} aria-label={t("attention.unreadItem")} />}
        </div>
        <strong className={s.title}>{item.title}</strong>
        <p className={s.summary}>{item.summary}</p>
        {item.cwd && <div className={`${s.path} chrome-mono`} title={item.cwd}>{item.cwd}</div>}
        <div className={s.actions}>
          <button type="button" className={s.primaryAction} onClick={() => void open(item)}>
            <ArrowUpRight size={15} aria-hidden />
            {item.sessionId ? t("attention.openSession") : t("attention.openSource")}
          </button>
          {!read && (
            <button type="button" className={s.secondary} onClick={() => onMarkRead(item.id)}>
              <Check size={15} aria-hidden />
              {t("attention.markRead")}
            </button>
          )}
        </div>
      </article>
    );
  };

  return (
    <section className={s.root} aria-label={t("attention.title")}>
      <header className={s.header}>
        <div className={s.heading}>
          <span className={s.headingIcon} aria-hidden><Bell size={17} strokeWidth={1.8} /></span>
          <div className={s.headingCopy}>
            <h2>{t("attention.title")}</h2>
            <p>{unreadCount > 0 ? `${unreadCount} ${t("attention.unread")}` : t("attention.caughtUp")}</p>
          </div>
          {unreadCount > 0 && <span className={s.unreadCount} aria-hidden>{Math.min(unreadCount, 99)}</span>}
        </div>
        <div className={s.toolbar} role="group" aria-label={t("attention.actions")}>
          <button
            type="button"
            className={`${s.toolbarButton} ${s.pushButton}`}
            onClick={() => void togglePush()}
            disabled={pushBusy || pushState === "loading" || pushState === "unavailable"}
            aria-pressed={pushState === "enabled"}
            aria-label={pushState === "enabled" ? t("attention.pushDisable") : t("attention.pushEnable")}
            title={pushState === "enabled" ? t("attention.pushDisable") : t("attention.pushEnable")}
          >
            {pushState === "enabled" ? <BellRing size={15} aria-hidden /> : <Bell size={15} aria-hidden />}
            <span>{t("attention.push")}</span>
          </button>
          <IconButton
            size="compact"
            className={loading ? s.refreshing : undefined}
            label={t("attention.refresh")}
            icon={<RefreshCw />}
            onClick={onRefresh}
            disabled={loading}
          />
          <button type="button" className={`${s.toolbarButton} ${s.markAllButton}`} onClick={onMarkAllRead} disabled={unreadCount === 0}>
            <CheckCheck size={16} aria-hidden />
            <span>{t("attention.markAllRead")}</span>
          </button>
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
            <span aria-hidden><CircleCheckBig size={20} strokeWidth={1.8} /></span>
            <strong>{t("attention.empty")}</strong>
            <p>{t("attention.emptyHint")}</p>
          </div>
        ) : groups.map((group) => (
          <section key={group.key} className={s.group}>
            <header className={s.groupHeader}>
              <h3>{t(`attention.group.${group.key}`)}</h3>
              <span>{group.items.length}</span>
              {group.key === "completed" && (
                <button type="button" className={s.clearGroup} onClick={() => onClearCompleted(group.items.map((item) => item.id))}>
                  <Trash2 size={14} aria-hidden />
                  {t("attention.clearCompleted")}
                </button>
              )}
            </header>
            <div className={s.groupItems}>{group.items.map(renderItem)}</div>
          </section>
        ))}
      </div>
    </section>
  );
}
