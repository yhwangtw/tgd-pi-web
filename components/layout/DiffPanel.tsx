"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { DiffViewMode } from "./text-viewer/DiffViewMode";
import type { DiffAnnotation } from "./DiffView";
import { getLanguage } from "@/lib/file-mime";
import { useI18n } from "@/lib/i18n";
import s from "./DiffPanel.module.css";

interface Props {
  cwd: string;
  path: string;
  onClose: () => void;
  onAnnotate?: (annotation: DiffAnnotation & { path: string }) => void;
}

/**
 * HEAD ↔ working-tree diff for one file, shown in the right panel when a
 * file is picked from the Changes view.
 */
export function DiffPanel({ cwd, path, onClose, onAnnotate }: Props) {
  const { t } = useI18n();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "tooLarge" }
    | { kind: "ready"; oldText: string; newText: string }
  >({ kind: "loading" });
  const [hunks, setHunks] = useState<Array<{ index: number; oldStart: number; newStart: number; label: string }>>([]);
  const [hunkPos, setHunkPos] = useState(0);
  const [reviewed, setReviewed] = useState<Set<number>>(() => new Set());
  const [reverting, setReverting] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const [res, hunkResponse] = await Promise.all([
          fetch(`/api/git/file-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`),
          fetch(`/api/git/file-hunks?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json() as { oldText?: string; newText?: string; tooLarge?: boolean; error?: string };
        const hunkPayload = hunkResponse.ok ? await hunkResponse.json() as { hunks?: Array<{ index: number; oldStart: number; newStart: number; label: string }> } : {};
        if (cancelled) return;
        if (d.error) setState({ kind: "error", message: d.error });
        else if (d.tooLarge) setState({ kind: "tooLarge" });
        else setState({ kind: "ready", oldText: d.oldText ?? "", newText: d.newText ?? "" });
        setHunks(hunkPayload.hunks ?? []);
        setHunkPos(0);
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, path]);

  useEffect(() => load(), [load]);

  const gotoHunk = useCallback((next: number) => {
    if (hunks.length === 0) return;
    const normalized = (next + hunks.length) % hunks.length;
    setHunkPos(normalized);
    const line = hunks[normalized].newStart;
    requestAnimationFrame(() => document.querySelector(`[data-diff-line="${line}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [hunks]);

  const revertHunk = useCallback(async () => {
    const hunk = hunks[hunkPos];
    if (!hunk || reverting) return;
    if (!window.confirm(`${t("files.diff.revertConfirm")} ${hunkPos + 1}/${hunks.length}\n${path}`)) return;
    setReverting(true);
    try {
      const response = await fetch("/api/git/file-hunks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, path, index: hunk.index }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setReviewed(new Set());
      load();
    } catch (reason) { setState({ kind: "error", message: reason instanceof Error ? reason.message : String(reason) }); }
    finally { setReverting(false); }
  }, [cwd, hunkPos, hunks, load, path, reverting, t]);

  return (
    <div className={s.container}>
      <div className={`${s.header} chrome-mono`}>
        <span className={s.badge}>diff</span>
        <span className={s.path} title={path}>{path}</span>
        {hunks.length > 0 && <div className={s.hunkNav}>
          <button onClick={() => gotoHunk(hunkPos - 1)} aria-label={t("files.diff.previousHunk")}>‹</button>
          <span>{hunkPos + 1}/{hunks.length}</span>
          <button onClick={() => gotoHunk(hunkPos + 1)} aria-label={t("files.diff.nextHunk")}>›</button>
          <button className={reviewed.has(hunks[hunkPos]?.index) ? s.reviewed : undefined} onClick={() => setReviewed((current) => { const next = new Set(current); const index = hunks[hunkPos].index; if (next.has(index)) next.delete(index); else next.add(index); return next; })}>{t(reviewed.has(hunks[hunkPos]?.index) ? "files.diff.reviewed" : "files.diff.keep")}</button>
          <button className={s.revertHunk} disabled={reverting} onClick={() => void revertHunk()}>{t(reverting ? "files.diff.reverting" : "files.diff.revertHunk")}</button>
        </div>}
        <button onClick={onClose} className={s.close} aria-label={t("files.diff.close")}>
          <X size={15} strokeWidth={2} aria-hidden />
        </button>
      </div>
      <div className={s.body}>
        {state.kind === "loading" && <div className={s.notice}>{t("files.diff.loading")}</div>}
        {state.kind === "error" && <div className={s.notice}>{t("files.diff.failed")}: {state.message}</div>}
        {state.kind === "tooLarge" && <div className={s.notice}>{t("files.diff.tooLarge")}</div>}
        {state.kind === "ready" && (
          <DiffViewMode
            oldContent={state.oldText}
            newContent={state.newText}
            language={getLanguage(path)}
            onAnnotate={onAnnotate ? (annotation) => onAnnotate({ ...annotation, path }) : undefined}
          />
        )}
      </div>
    </div>
  );
}
