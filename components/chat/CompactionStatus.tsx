"use client";

import { useState } from "react";
import { LoaderCircle, Shrink, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { CompactionView } from "@/hooks/use-session-compaction";
import styles from "./CompactionStatus.module.css";

export function CompactionStatus({ state, queued, onCancel, onCheck, onRetry, onDismiss, onClear }: {
  state: CompactionView | null; queued: number;
  onCancel: () => Promise<void>; onCheck: () => Promise<void>; onRetry: () => Promise<void>;
  onDismiss: () => void; onClear: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  if (!state && !queued) return null;
  const running = state?.status === "running" || state?.status === "checking";
  const title = state?.status === "running" ? t("chat.compacting")
    : state?.status === "checking" ? t("compact.checking")
    : state?.status === "unknown" ? t("compact.unknown")
    : state?.status === "completed" ? t("toast.compactDone")
    : state?.status === "cancelled" ? t("toast.compactCancelled")
    : state?.status === "failed" ? t(state.reason === "queue" ? "compact.queueFailed" : "toast.compactFailed")
    : state?.status === "skipped" ? t(state.notice === "already_compacted" ? "compact.already" : "compact.small") : "";
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setActionFailed(false);
    try { await run(); } catch { setActionFailed(true); } finally { setBusy(false); }
  };
  return <section className={styles.panel} data-testid="compaction-status" data-state={state?.status} aria-label={t("compact.status")}
    onPointerDown={event => {
      // Blurring the composer restores mobile navigation between pointerdown
      // and click, moving this bar out from under the pointer. Keep keyboard
      // focus for pointer actions; Tab navigation is unaffected.
      if ((event.target as HTMLElement).closest("button") && document.activeElement instanceof HTMLTextAreaElement) event.preventDefault();
    }}>
    <div className={styles.row}>
      {running ? <LoaderCircle size={15} className={styles.spinner} aria-hidden /> : <Shrink size={15} aria-hidden />}
      <span className={styles.label} role="status">{title}</span>
      {running && <button disabled={busy} onClick={() => void action(onCancel)}>{t("compact.cancel")}</button>}
      {(state?.status === "checking" || state?.status === "unknown") && <button disabled={busy} onClick={() => void action(onCheck)}>{t("compact.check")}</button>}
      {(state?.status === "failed" || state?.status === "unknown") && <button disabled={busy} onClick={() => void action(onRetry)}>{t("compact.retry")}</button>}
      {!running && state && <button className={styles.dismiss} onClick={onDismiss} aria-label={t("compact.dismiss")}><X size={14} /></button>}
    </div>
    {running && <p>{t(state?.status === "checking" ? "compact.reconciling" : "compact.queueHint")}</p>}
    {state?.status === "unknown" && <p>{t("compact.unknownHint")}</p>}
    {state?.status === "completed" && state.result && Number.isFinite(state.result.tokensBefore) && Number.isFinite(state.result.estimatedTokensAfter) && <p className={styles.tokens}>{t("compact.tokens").replace("{before}", state.result.tokensBefore.toLocaleString()).replace("{after}", state.result.estimatedTokensAfter.toLocaleString())}</p>}
    {queued > 0 && <div className={styles.row}><span className={styles.label}>{t("compact.queued").replace("{count}", String(queued))}</span><button disabled={busy} onClick={() => void action(onClear)}>{t("compact.clear")}</button></div>}
    {state?.status === "failed" && state.error && <details><summary>{t("compact.details")}</summary><pre>{state.error}</pre></details>}
    {actionFailed && <p role="alert">{t("compact.actionFailed")}</p>}
  </section>;
}
