"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open, onClose]);

  if (!open) return null;

  const maxMonthlyCost = Math.max(1, ...(summary?.monthly.map((m) => m.cost) ?? [0]));
  const topSessions = [...perSession]
    .sort((a, b) => b.usage.total.cost.total - a.usage.total.cost.total)
    .slice(0, 10);

  return (
    <div className={styles.overlay}>
      <button type="button" tabIndex={-1} className={styles.overlayBackdrop} onClick={onClose} aria-label="Dismiss analytics" />
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="analytics-title">
        <div className={styles.header}>
          <div>
            <h2 id="analytics-title">Session Analytics</h2>
            <p>Usage and cost across your recent work</p>
          </div>
          <button onClick={onClose} className={styles.closeButton} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {loading && <div className={styles.loading}>Loading…</div>}
        {error && <div className={styles.error}>{error}</div>}

        {!loading && !error && summary && (
          <div className={styles.body}>
            <div className={styles.statRow}>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Total cost</div>
                <div className={styles.statValue}>{fmtMoney(summary.totalCost)}</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Total tokens</div>
                <div className={styles.statValue}>{fmtTokens(summary.totalTokens)}</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Sessions</div>
                <div className={styles.statValue}>{summary.sessionCount}</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Messages</div>
                <div className={styles.statValue}>{summary.totalMessages}</div>
              </div>
            </div>

            {summary.monthly.length > 0 && (
              <section className={styles.section}>
                <h3>Monthly cost</h3>
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
                      <div className={styles.barMeta}>{m.sessions} sessions · {fmtTokens(m.tokens)}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {summary.byModel.length > 0 && (
              <section className={styles.section}>
                <h3>By model</h3>
                <div className={styles.table}>
                  <div className={styles.tableHeader}>
                    <span>Model</span>
                    <span>Cost</span>
                    <span>In / Out</span>
                    <span>Sessions</span>
                  </div>
                  {summary.byModel.map((m) => (
                    <div key={m.model} className={styles.tableRow}>
                      <span className={styles.modelName} title={m.model}>
                        {m.model.split("/").pop()}
                      </span>
                      <span data-label="Cost">{fmtMoney(m.cost)}</span>
                      <span className={styles.tokenCol} data-label="In / Out">
                        {fmtTokens(m.input)} / {fmtTokens(m.output)}
                      </span>
                      <span data-label="Sessions">{m.sessions}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {summary.byProvider.length > 0 && (
              <section className={styles.section}>
                <h3>By provider</h3>
                <div className={styles.providerRow}>
                  {summary.byProvider.map((p) => (
                    <div key={p.provider} className={styles.providerChip}>
                      <strong>{p.provider}</strong>
                      <span>{fmtMoney(p.cost)}</span>
                      <span className={styles.dim}>{p.sessions} sessions</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {topSessions.length > 0 && (
              <section className={styles.section}>
                <h3>Top 10 sessions by cost</h3>
                <div className={styles.table}>
                  <div className={styles.tableHeader}>
                    <span>Session</span>
                    <span>Cost</span>
                    <span>Tokens</span>
                    <span>Msgs</span>
                  </div>
                  {topSessions.map((s) => (
                    <div key={s.id} className={styles.tableRow}>
                      <span className={styles.modelName} title={s.id}>
                        {s.name || basename(s.cwd) || s.id.slice(0, 8)}
                      </span>
                      <span data-label="Cost">{fmtMoney(s.usage.total.cost.total)}</span>
                      <span className={styles.tokenCol} data-label="Tokens">
                        {fmtTokens(s.usage.total.input + s.usage.total.output)}
                      </span>
                      <span data-label="Messages">{s.messageCount}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
