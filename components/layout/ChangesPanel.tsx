"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, GitBranch, RefreshCw, RotateCcw } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/hooks/useToast";
import s from "./ChangesPanel.module.css";

interface ChangedFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

interface Snapshot {
  id: string;
  ts: number;
  label: string;
  fileCount: number;
  impact: {
    total: number;
    restore: number;
    remove: number;
    changes: Array<{ path: string; action: "restore" | "remove"; status: string }>;
  };
}

interface Props {
  cwd: string | null;
  sessionId?: string | null;
  /** Re-fetch when this changes (bumped after each agent turn). */
  refreshKey?: number;
  onOpenDiff: (path: string) => void;
  selectedPath?: string | null;
}

function snapTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

const STATUS_CLASS: Record<string, string> = {
  M: "statusM",
  A: "statusA",
  D: "statusD",
  R: "statusR",
  "??": "statusU",
};

/**
 * Working-tree changes for the session cwd — the "what did the agent just
 * touch" view. Click a file to open its HEAD↔worktree diff.
 */
export function ChangesPanel({ cwd, sessionId, refreshKey, onOpenDiff, selectedPath }: Props) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [isGit, setIsGit] = useState(true);
  const [loading, setLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapsOpen, setSnapsOpen] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const snapshotRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    if (!cwd) {
      setFiles([]);
      setBranch(null);
      setIsGit(true);
      setLoading(false);
      return;
    }
    setFiles([]);
    setBranch(null);
    setIsGit(true);
    setLoading(true);
    try {
      const res = await fetch(`/api/git/changes?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { git: boolean; branch: string | null; files: ChangedFile[] };
      if (requestId !== loadRequestRef.current) return;
      setIsGit(d.git);
      setBranch(d.branch);
      setFiles(d.files ?? []);
    } catch {
      if (requestId !== loadRequestRef.current) return;
      setFiles([]);
      setBranch(null);
      setIsGit(true);
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [cwd]);

  const loadSnapshots = useCallback(async () => {
    const requestId = ++snapshotRequestRef.current;
    setSnapshots([]);
    if (!cwd || !sessionId) return;
    try {
      const res = await fetch(`/api/git/snapshots?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const d = await res.json() as { git: boolean; snapshots: Snapshot[] };
      if (requestId !== snapshotRequestRef.current) return;
      setSnapshots(d.snapshots ?? []);
    } catch {
      if (requestId !== snapshotRequestRef.current) return;
      setSnapshots([]);
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    load();
    loadSnapshots();
  }, [load, loadSnapshots, refreshKey]);

  const restore = useCallback(async (snap: Snapshot) => {
    if (!cwd || !sessionId) return;
    setRestoringId(snap.id);
    try {
      const prepareRes = await fetch("/api/git/snapshots/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "prepare", cwd, sessionId, id: snap.id }),
      });
      const prepared = await prepareRes.json() as {
        confirmation?: { token: string; expiresAt: number };
        review?: { label: string; impact: Snapshot["impact"] };
        error?: string;
      };
      if (!prepareRes.ok || prepared.error || !prepared.confirmation || !prepared.review) {
        throw new Error(prepared.error ?? `HTTP ${prepareRes.status}`);
      }
      if (JSON.stringify(prepared.review.impact) !== JSON.stringify(snap.impact)) {
        setSnapshots((current) => current.map((item) => item.id === snap.id
          ? { ...item, impact: prepared.review!.impact }
          : item));
        showToast(t("changes.restoreChanged"), { type: "warning" });
        return;
      }
      const res = await fetch("/api/git/snapshots/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: "execute",
          cwd,
          sessionId,
          id: snap.id,
          confirmationToken: prepared.confirmation.token,
        }),
      });
      const d = await res.json() as { ok?: boolean; restored?: number; removed?: number; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      showToast(t("changes.restoreSuccess")
        .replace("{restored}", String(d.restored ?? 0))
        .replace("{removed}", String(d.removed ?? 0)), { type: "success" });
      setReviewingId(null);
      await load();
      await loadSnapshots();
    } catch (e) {
      showToast(`${t("changes.restoreFailed")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
    } finally {
      setRestoringId(null);
    }
  }, [cwd, sessionId, showToast, load, loadSnapshots, t]);

  const commit = useCallback(async () => {
    if (!cwd || committing) return;
    const message = commitMsg.trim();
    if (!message) return;
    setCommitting(true);
    try {
      const res = await fetch("/api/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, message }),
      });
      const d = await res.json() as { ok?: boolean; sha?: string; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      showToast(`${t("changes.committed")} ${d.sha ?? ""}`.trim(), { type: "success" });
      setCommitMsg("");
      await load();
    } catch (e) {
      showToast(`${t("changes.commitFailed")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
    } finally {
      setCommitting(false);
    }
  }, [cwd, committing, commitMsg, showToast, t, load]);

  const discard = useCallback(async (path: string) => {
    if (!cwd) return;
    if (!window.confirm(t("changes.discardConfirm").replace("{path}", path))) return;
    setDiscarding(path);
    try {
      const res = await fetch("/api/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, action: "discard", path }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      showToast(`${t("changes.discardFailed")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
    } finally {
      setDiscarding(null);
    }
  }, [cwd, showToast, t, load]);

  if (!cwd) {
    return <div className={s.empty}>{t("sidebar.selectProjectFirst")}</div>;
  }

  return (
    <div className={s.container}>
      <div className={`${s.header} chrome-mono`}>
        <GitBranch size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className={s.branch} title={branch ?? undefined}>{branch ?? "—"}</span>
        <span className={s.count}>{files.length}</span>
        <IconButton
          label={t("common.refresh")}
          icon={<RefreshCw className={loading ? s.spinning : undefined} strokeWidth={1.8} />}
          size="compact"
          onClick={() => { if (!loading) void load(); }}
          className={s.refresh}
          aria-busy={loading}
        />
      </div>

      {!isGit ? (
        <div className={s.empty}>{t("changes.notGit")}</div>
      ) : files.length === 0 ? (
        <div className={s.empty}>
          <CheckCircle2 size={22} strokeWidth={1.6} aria-hidden="true" />
          <span>{t("changes.clean")}</span>
        </div>
      ) : (
        <div className={s.list}>
          {files.map((f) => (
            <div
              key={f.path}
              onClick={() => onOpenDiff(f.path)}
              className={`hover-group ${s.item} ${selectedPath === f.path ? s.itemSelected : ""}`}
              title={f.path}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenDiff(f.path);
                }
              }}
            >
              <span className={`${s.status} ${s[STATUS_CLASS[f.status] ?? "statusM"]} chrome-mono`}>
                {f.status === "??" ? "U" : f.status.slice(0, 1)}
              </span>
              <span className={s.path}>{f.path}</span>
              {(f.additions !== null || f.deletions !== null) && (
                <span className={`${s.stat} chrome-mono`}>
                  {f.additions !== null && <span className={s.add}>+{f.additions}</span>}
                  {f.deletions !== null && <span className={s.del}>−{f.deletions}</span>}
                </span>
              )}
              <IconButton
                label={t("changes.discard")}
                icon={<RotateCcw strokeWidth={1.8} />}
                size="compact"
                onClick={(e) => { e.stopPropagation(); void discard(f.path); }}
                disabled={discarding === f.path}
                className={`hover-reveal ${s.discardBtn}`}
              />
            </div>
          ))}
        </div>
      )}

      {/* Commit box */}
      {isGit && files.length > 0 && (
        <div className={s.commitBox}>
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void commit(); }}
            placeholder={t("changes.commitPlaceholder")}
            className={s.commitInput}
            rows={2}
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => void commit()}
            disabled={committing || !commitMsg.trim()}
            className={s.commitBtn}
          >
            {committing ? t("changes.committing") : `${t("changes.commitAll")} (${files.length})`}
          </button>
        </div>
      )}

      {/* Restore points — snapshots captured before each agent run */}
      {isGit && sessionId && snapshots.length > 0 && (
        <div className={s.snapSection}>
          <button
            type="button"
            className={`${s.snapHeader} chrome-mono`}
            onClick={() => setSnapsOpen((v) => !v)}
            aria-expanded={snapsOpen}
          >
            <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" className={snapsOpen ? s.caretOpen : s.caretClosed} />
            <span>{t("changes.restorePoints")}</span>
            <span className={s.count}>{snapshots.length}</span>
          </button>
          {snapsOpen && (
            <div className={s.snapList}>
              {snapshots.map((snap) => (
                <div key={snap.id} className={`${s.snapItem} ${reviewingId === snap.id ? s.snapItemReviewing : ""}`}>
                  <div className={s.snapRow}>
                    <div className={s.snapMain}>
                      <span className={s.snapLabel} title={snap.label}>{snap.label}</span>
                      <span className={`${s.snapMeta} chrome-mono`}>
                        {snapTime(snap.ts)} · {t("changes.restoreAffected").replace("{count}", String(snap.impact.total))}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReviewingId((current) => current === snap.id ? null : snap.id)}
                      disabled={restoringId !== null}
                      className={s.snapRestore}
                      aria-expanded={reviewingId === snap.id}
                    >
                      {t("changes.restoreReview")}
                    </button>
                  </div>
                  {reviewingId === snap.id && (
                    <div className={s.restorePreview} role="region" aria-label={t("changes.restorePreviewLabel")}>
                      <p className={s.restoreSummary}>
                        {t("changes.restoreSummary")
                          .replace("{restore}", String(snap.impact.restore))
                          .replace("{remove}", String(snap.impact.remove))}
                      </p>
                      <div className={s.restoreFiles}>
                        {snap.impact.changes.slice(0, 12).map((change) => (
                          <button
                            type="button"
                            key={`${change.action}:${change.path}`}
                            className={s.restoreFile}
                            onClick={() => onOpenDiff(change.path)}
                            title={change.path}
                          >
                            <span className={change.action === "remove" ? s.restoreRemove : s.restoreRevert}>
                              {t(change.action === "remove" ? "changes.restoreRemove" : "changes.restoreRevert")}
                            </span>
                            <span>{change.path}</span>
                          </button>
                        ))}
                        {snap.impact.total > snap.impact.changes.slice(0, 12).length && (
                          <span className={s.restoreMore}>
                            {t("changes.restoreMore").replace("{count}", String(snap.impact.total - 12))}
                          </span>
                        )}
                      </div>
                      <div className={s.restoreActions}>
                        <button type="button" className={s.restoreCancel} onClick={() => setReviewingId(null)}>
                          {t("common.cancel")}
                        </button>
                        <button
                          type="button"
                          className={s.restoreConfirm}
                          onClick={() => void restore(snap)}
                          disabled={restoringId !== null}
                        >
                          {restoringId === snap.id ? t("changes.restoring") : t("changes.restoreConfirm")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
