"use client";

import { useEffect, useState } from "react";
import { DialogShell } from "@/components/ui/DialogShell";
import { useI18n } from "@/lib/i18n";
import styles from "./AnalyticsModal.module.css";

interface SessionAnalytics {
  id: string;
  name?: string;
  cwd: string;
  messageCount: number;
  modified: string;
  compactions: number;
  usage: {
    total: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
    byModel: Record<string, { cost: { total: number }; input: number; output: number }>;
  };
}

interface Summary {
  totalCost: number;
  totalTokens: number;
  totalMessages: number;
  sessionCount: number;
  monthly: Array<{ month: string; cost: number; tokens: number; sessions: number; messages: number }>;
  byModel: Array<{ model: string; cost: number; input: number; output: number; sessions: number }>;
  byProvider: Array<{ provider: string; cost: number; sessions: number }>;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function fmtMoney(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

export function AnalyticsModal({ open, onClose }: Props) {
  const { t } = useI18n();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [perSession, setPerSession] = useState<SessionAnalytics[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch("/api/sessions/analytics")
      .then((r) => r.json() as Promise<{ summary?: Summary; perSession?: SessionAnalytics[]; error?: string }>)
      .then((data) => {
        if (data.error) setError(data.error);
        else {
          setSummary(data.summary ?? null);
          setPerSession(data.perSession ?? []);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const maxMonthlyCost = Math.max(1, ...(summary?.monthly.map((m) => m.cost) ?? [0]));
  const topSessions = [...perSession]
    .sort((a, b) => b.usage.total.cost.total - a.usage.total.cost.total)
    .slice(0, 10);

  return (
    <DialogShell
      open
      title={t("analytics.title")}
      description={t("analytics.subtitle")}
      onClose={onClose}
      size="wide"
      mobileMode="fullscreen"
      bodyClassName={styles.shellBody}
    >
        {loading && <div className={styles.loading}>{t("common.loading")}</div>}
        {error && <div className={styles.error}>{error}</div>}

        {!loading && !error && summary && (
          <div className={styles.body}>
            <div className={styles.statRow}>
              <div className={styles.stat}>
                <div className={styles.statLabel}>{t("analytics.totalCost")}</div>
                <div className={styles.statValue}>{fmtMoney(summary.totalCost)}</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>{t("analytics.totalTokens")}</div>
                <div className={styles.statValue}>{fmtTokens(summary.totalTokens)}</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>{t("analytics.sessions")}</div>
                <div className={styles.statValue}>{summary.sessionCount}</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>{t("analytics.messages")}</div>
                <div className={styles.statValue}>{summary.totalMessages}</div>
              </div>
            </div>

            {summary.monthly.length > 0 && (
              <section className={styles.section}>
                <h3>{t("analytics.monthlyCost")}</h3>
                <div className={styles.bars}>
                  {summary.monthly.map((m) => (
                    <div key={m.month} className={styles.barRow}>
                      <div className={styles.barLabel}>{m.month}</div>
                      <div className={styles.barTrack}>
                        <div
                          className={styles.barFill}
                          style={{ width: `${(m.cost / maxMonthlyCost) * 100}%` }}
                        />
                      </div>
                      <div className={styles.barValue}>{fmtMoney(m.cost)}</div>
                      <div className={styles.barMeta}>{t("analytics.sessionCount").replace("{count}", String(m.sessions))} · {fmtTokens(m.tokens)}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {summary.byModel.length > 0 && (
              <section className={styles.section}>
                <h3>{t("analytics.byModel")}</h3>
                <div className={styles.table}>
                  <div className={styles.tableHeader}>
                    <span>{t("analytics.model")}</span>
                    <span>{t("analytics.cost")}</span>
                    <span>{t("analytics.inOut")}</span>
                    <span>{t("analytics.sessions")}</span>
                  </div>
                  {summary.byModel.map((m) => (
                    <div key={m.model} className={styles.tableRow}>
                      <span className={styles.modelName} title={m.model}>
                        {m.model.split("/").pop()}
                      </span>
                      <span data-label={t("analytics.cost")}>{fmtMoney(m.cost)}</span>
                      <span className={styles.tokenCol} data-label={t("analytics.inOut")}>
                        {fmtTokens(m.input)} / {fmtTokens(m.output)}
                      </span>
                      <span data-label={t("analytics.sessions")}>{m.sessions}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {summary.byProvider.length > 0 && (
              <section className={styles.section}>
                <h3>{t("analytics.byProvider")}</h3>
                <div className={styles.providerRow}>
                  {summary.byProvider.map((p) => (
                    <div key={p.provider} className={styles.providerChip}>
                      <strong>{p.provider}</strong>
                      <span>{fmtMoney(p.cost)}</span>
                      <span className={styles.dim}>{t("analytics.sessionCount").replace("{count}", String(p.sessions))}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {topSessions.length > 0 && (
              <section className={styles.section}>
                <h3>{t("analytics.topSessions")}</h3>
                <div className={styles.table}>
                  <div className={styles.tableHeader}>
                    <span>{t("analytics.session")}</span>
                    <span>{t("analytics.cost")}</span>
                    <span>{t("analytics.tokens")}</span>
                    <span>{t("analytics.msgs")}</span>
                  </div>
                  {topSessions.map((s) => (
                    <div key={s.id} className={styles.tableRow}>
                      <span className={styles.modelName} title={s.id}>
                        {s.name || basename(s.cwd) || s.id.slice(0, 8)}
                      </span>
                      <span data-label={t("analytics.cost")}>{fmtMoney(s.usage.total.cost.total)}</span>
                      <span className={styles.tokenCol} data-label={t("analytics.tokens")}>
                        {fmtTokens(s.usage.total.input + s.usage.total.output)}
                      </span>
                      <span data-label={t("analytics.messages")}>{s.messageCount}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
    </DialogShell>
  );
}
