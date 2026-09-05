"use client";

import { lazy, Suspense, useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Info, MoreHorizontal } from "lucide-react";
import { encodeFilePathForApi, getRelativeFilePath } from "@/lib/file-paths";
import { useI18n } from "@/lib/i18n";
import type { FileOpenMode, FileViewState } from "@/lib/file-open";
import { useFileWatch } from "@/hooks/useFileWatch";
import { formatSize, type FileData } from "./file-viewer-utils";
import { SourceView } from "./text-viewer/SourceView";
import { PlainSourceView } from "./text-viewer/PlainSourceView";
import { DiffViewMode } from "./text-viewer/DiffViewMode";
import { StructuredDataView } from "./text-viewer/StructuredDataView";
import { FileInspectorDrawer } from "./FileInspectorDrawer";
import { buildFileAgentPrompt, extractFileOutline, type TextSelectionRange } from "@/lib/file-workbench";
import { showToast } from "@/hooks/useToast";
import { ActionMenu, ActionMenuItem } from "@/components/ui/ActionMenu";
import styles from "./TextFileViewer.module.css";

const LazyPreviewView = lazy(() => import("./text-viewer/PreviewView").then((module) => ({ default: module.PreviewView })));

interface Props {
  filePath: string;
  cwd?: string;
  /** Jump to this 1-based line on open (from a search hit). */
  gotoLine?: number;
  /** Bumped per jump request, so reopening an open file re-triggers the jump. */
  gotoNonce?: number;
  onSendToAgent?: (prompt: string) => void;
  sessionId?: string | null;
  initialMode?: FileOpenMode;
  initialViewState?: FileViewState;
  onViewStateChange?: (viewState: FileViewState) => void;
  onNavigationConsumed?: () => void;
}

type InspectorTab = "outline" | "problems" | "history" | "blame" | "notes";

export function TextFileViewer({ filePath, cwd, gotoLine: gotoLineProp, gotoNonce, onSendToAgent, sessionId, initialMode = "auto", initialViewState, onViewStateChange, onNavigationConsumed }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<FileData | null>(null);
  const [prevContent, setPrevContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [viewMode, setViewMode] = useState<"source" | "diff">("source");
  const [wrapLines, setWrapLines] = useState(false);
  const [structuredMode, setStructuredMode] = useState(false);
  const [changeCount, setChangeCount] = useState(0);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [previewRenderMs, setPreviewRenderMs] = useState<number | null>(null);
  const [selection, setSelection] = useState<TextSelectionRange | null>(null);
  const [version, setVersion] = useState<{ ref: string; label: string; content: string } | null>(null);
  const [diagnostics, setDiagnostics] = useState<Array<{ line: number; severity: "error" | "warning" }>>([]);
  const fileInfoRef = useRef<HTMLDetailsElement>(null);
  const previewStartedAtRef = useRef<number | null>(null);
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const loadedFilePathRef = useRef<string | null>(null);
  const activeFilePathRef = useRef(filePath);
  activeFilePathRef.current = filePath;
  const dataRef = useRef(data);
  dataRef.current = data;
  const readRequestRef = useRef<AbortController | null>(null);
  const saveRequestRef = useRef<AbortController | null>(null);
  const initialViewStateRef = useRef(initialViewState);
  const initialModeRef = useRef(initialMode);
  initialModeRef.current = initialMode;
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreMonitorRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restoredViewKeyRef = useRef<string | null>(null);
  const restoringViewRef = useRef(true);
  const pendingGotoLineRef = useRef(gotoLineProp);
  const pendingGotoLineKeyRef = useRef<string | null>(null);
  initialViewStateRef.current = initialViewState;
  const openNavigationKey = `${filePath}:${gotoNonce ?? "initial"}`;
  if (pendingGotoLineKeyRef.current !== openNavigationKey) {
    pendingGotoLineKeyRef.current = openNavigationKey;
    pendingGotoLineRef.current = gotoLineProp;
  }
  const { watching, refreshTrigger } = useFileWatch(filePath);

  const stopRestoringView = useCallback(() => {
    if (restoreMonitorRef.current) {
      clearInterval(restoreMonitorRef.current);
      restoreMonitorRef.current = null;
    }
    restoringViewRef.current = false;
  }, []);

  const restoreReadingPosition = useCallback((scrollTop: number) => {
    stopRestoringView();
    const area = contentAreaRef.current;
    if (!area) return;

    const target = Math.max(0, scrollTop);
    if (target === 0) {
      area.scrollTop = 0;
      return;
    }

    restoringViewRef.current = true;
    let lastScrollHeight = -1;
    const deadline = performance.now() + 1_500;
    const apply = () => {
      if (contentAreaRef.current !== area) {
        stopRestoringView();
        return;
      }
      const available = Math.max(0, area.scrollHeight - area.clientHeight);
      const next = Math.min(target, available);
      if (area.scrollTop !== next) area.scrollTop = next;
      lastScrollHeight = area.scrollHeight;
    };

    // SyntaxHighlighter and lazy previews can replace their compact first
    // paint after this component has restored the tab. Keep the intended
    // position alive briefly while the child settles, then get out of the
    // reader's way. Pointer/wheel/touch interaction cancels this monitor.
    apply();
    restoreMonitorRef.current = setInterval(() => {
      if (performance.now() >= deadline) {
        apply();
        stopRestoringView();
        return;
      }
      if (area.scrollHeight !== lastScrollHeight) apply();
    }, 80);
  }, [stopRestoringView]);

  // ── In-file find / go-to-line ────────────────────────────────────────────
  const [findQuery, setFindQuery] = useState("");
  const [findPos, setFindPos] = useState(0);
  // Debounced: activeLine flips per-line rendering in the highlighter — don't
  // re-render a big file on every keystroke.
  const [debouncedFind, setDebouncedFind] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFind(findQuery), 150);
    return () => clearTimeout(t);
  }, [findQuery]);

  // Large files skip syntax highlighting by default (Prism on thousands of
  // lines janks for seconds); a toolbar button forces it when wanted.
  const [forceHighlight, setForceHighlight] = useState(false);

  // ── Edit mode ────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editBaseVersion, setEditBaseVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<FileData | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const fetchContent = useCallback((filePath: string, isRefresh = false) => {
    readRequestRef.current?.abort();
    const controller = new AbortController();
    readRequestRef.current = controller;
    const encoded = encodeFilePathForApi(filePath);
    const current = () => !controller.signal.aborted && readRequestRef.current === controller && activeFilePathRef.current === filePath;
    return fetch(`/api/files/${encoded}?type=read`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d: FileData & { error?: string }) => {
        if (!current() || (isRefresh && editingRef.current)) return null;
        if (d.error) {
          setError(d.error);
          return null;
        }
        if (isRefresh) {
          if (dataRef.current) setPrevContent(dataRef.current.content);
          setChangeCount((c) => c + 1);
        } else {
          // Set the owner before React commits `data`. A file-path prop change
          // briefly renders with the previous file's data; the restore effect
          // must not consume the new tab's restore key during that stale frame.
          loadedFilePathRef.current = filePath;
        }
        dataRef.current = d;
        setData(d);
        return d;
      })
      .catch((e) => {
        if (current()) setError(String(e));
        return null;
      });
  }, []);

  // Initial load
  useEffect(() => {
    let active = true;
    loadedFilePathRef.current = null;
    dataRef.current = null;
    setLoading(true);
    setError(null);
    setData(null);
    setPrevContent(null);
    setPreviewMode(false);
    setViewMode("source");
    setWrapLines(false);
    setStructuredMode(false);
    setChangeCount(0);
    setInspectorTab(null);
    setSelection(null);
    setVersion(null);
    setDiagnostics([]);

    fetchContent(filePath).then((d) => {
      if (!active || !d) return;
      // Large files arrive as a guarded prefix and default to the fast plain
      // source view. Preview remains an explicit opt-in for that sample.
      const mode = initialModeRef.current;
      if ((mode === "preview" || (mode === "auto" && d.language === "markdown")) && !d.truncated) {
        previewStartedAtRef.current = performance.now();
        setPreviewMode(true);
      }
    }).finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      readRequestRef.current?.abort();
      saveRequestRef.current?.abort();
      saveRequestRef.current = null;
    };
  }, [filePath, fetchContent]);

  useEffect(() => {
    if (editingRef.current || loadedFilePathRef.current !== filePath || !dataRef.current) return;
    const current = dataRef.current;
    setPreviewMode(!current.truncated && (initialMode === "preview" || (initialMode === "auto" && current.language === "markdown")));
  }, [filePath, initialMode]);

  // A same-file jump must preserve the draft and an in-flight save.
  useEffect(() => {
    setEditing(false);
    editingRef.current = false;
    setDraft("");
    setEditBaseVersion(null);
    setSaving(false);
    setSaveProblem(null);
    setConflict(null);
  }, [filePath]);

  // Refresh on file-watch change events — debounced 300ms so an agent
  // writing in bursts triggers one reload, and never clobber an open editor.
  useEffect(() => {
    if (refreshTrigger === 0) return;
    const t = setTimeout(() => {
      if (!editingRef.current) fetchContent(filePath, true);
    }, 300);
    return () => clearTimeout(t);
  }, [refreshTrigger, filePath, fetchContent]);

  // Reset transient navigation state for each jump request.
  useEffect(() => {
    restoringViewRef.current = true;
    restoredViewKeyRef.current = null;
    if (restoreMonitorRef.current) {
      clearInterval(restoreMonitorRef.current);
      restoreMonitorRef.current = null;
    }
    if (scrollSaveTimerRef.current) {
      clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = null;
    }
    setFindQuery("");
    setFindPos(0);
    setForceHighlight(false);
    setMoreOpen(false);
    setPreviewRenderMs(null);
    previewStartedAtRef.current = null;
    setSelection(pendingGotoLineRef.current ? null : initialViewStateRef.current?.selection ?? null);
    setVersion(null);
  }, [filePath, gotoNonce]);

  // Jump to a line requested by a search hit. Reuses the ":N" go-to-line path
  // (seeds the find box), so the existing active-line scroll handles it. Keyed
  // on gotoNonce so reopening an already-open file at a new line re-fires.
  // Declared after the reset effect above so it wins on a fresh open.
  useEffect(() => {
    if (gotoLineProp && gotoLineProp > 0) {
      setViewMode("source");
      setPreviewMode(false);
      setStructuredMode(false);
      setFindQuery(`:${gotoLineProp}`);
      onNavigationConsumed?.();
    }
  }, [gotoLineProp, gotoNonce, onNavigationConsumed]);

  useEffect(() => {
    if (!data || loadedFilePathRef.current !== filePath || !contentAreaRef.current) return;
    const key = `${filePath}:${gotoNonce ?? "initial"}:${viewMode}:${previewMode ? "preview" : structuredMode ? "structured" : "source"}`;
    if (restoredViewKeyRef.current === key) return;
    restoredViewKeyRef.current = key;
    const frame = requestAnimationFrame(() => {
      if (restoredViewKeyRef.current !== key) return;
      if (pendingGotoLineRef.current) {
        stopRestoringView();
        if (contentAreaRef.current) contentAreaRef.current.scrollTop = 0;
        return;
      }
      restoreReadingPosition(initialViewStateRef.current?.scrollTop ?? 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (restoredViewKeyRef.current === key) stopRestoringView();
    };
  }, [data, filePath, gotoNonce, previewMode, restoreReadingPosition, stopRestoringView, structuredMode, viewMode]);

  useEffect(() => () => {
    if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
    stopRestoringView();
  }, [stopRestoringView]);

  // Line numbers (1-based) matching the (debounced) find query; ":123" jumps.
  const matches = useMemo(() => {
    if (!data) return [] as number[];
    const q = debouncedFind.trim().toLowerCase();
    if (!q || q.startsWith(":")) return [];
    const out: number[] = [];
    data.content.split("\n").forEach((line, i) => {
      if (line.toLowerCase().includes(q)) out.push(i + 1);
    });
    return out;
  }, [data, debouncedFind]);

  const lineCount = useMemo(() => (data ? data.content.split("\n").length : 0), [data]);
  const isLarge = !!data && (data.size > 150_000 || lineCount > 1500);
  const usePlain = isLarge && !forceHighlight;

  const gotoLine = debouncedFind.trim().startsWith(":") ? parseInt(debouncedFind.trim().slice(1), 10) : NaN;
  const activeLine = Number.isFinite(gotoLine) && gotoLine > 0
    ? gotoLine
    : matches.length > 0
      ? matches[Math.min(findPos, matches.length - 1)]
      : null;

  const copyContent = useCallback(() => {
    if (!data) return;
    navigator.clipboard?.writeText(data.content)
      .then(() => showToast(t("files.copied")))
      .catch(() => {});
  }, [data, t]);

  const startPreview = useCallback(() => {
    previewStartedAtRef.current = performance.now();
    setPreviewRenderMs(null);
    setPreviewMode(true);
    setStructuredMode(false);
  }, []);

  const handlePreviewRendered = useCallback(() => {
    const start = previewStartedAtRef.current;
    if (start === null) return;
    const end = performance.now();
    const duration = Math.max(0, end - start);
    previewStartedAtRef.current = null;
    setPreviewRenderMs(Math.round(duration));
    try {
      performance.measure("pi:file-preview-render", {
        start,
        end,
        detail: { language: data?.language ?? "unknown", size: data?.size ?? 0 },
      });
    } catch { /* older browsers still get the visible measurement */ }
    window.dispatchEvent(new CustomEvent("pi:file-preview-render", {
      detail: { durationMs: duration, language: data?.language ?? "unknown", size: data?.size ?? 0 },
    }));
    // Suspense initially commits a compact fallback; once the real preview
    // chunk paints, restore the tab's saved reading position against its final
    // scroll height instead of leaving the viewport clamped to zero.
    if (!pendingGotoLineRef.current) {
      restoreReadingPosition(initialViewStateRef.current?.scrollTop ?? 0);
    }
  }, [data?.language, data?.size, restoreReadingPosition]);

  const startEditing = useCallback(() => {
    if (!data?.version || loadedFilePathRef.current !== filePath) return;
    readRequestRef.current?.abort();
    editingRef.current = true;
    setDraft(data.content);
    setEditBaseVersion(data.version);
    setEditing(true);
    setSaveProblem(null);
    setConflict(null);
    setFindQuery("");
  }, [data, filePath]);

  const saveEdit = useCallback(async (reviewedVersion?: string) => {
    if (saveRequestRef.current || !editingRef.current || loadedFilePathRef.current !== filePath || (conflict && !reviewedVersion)) return;
    const expectedVersion = reviewedVersion ?? editBaseVersion;
    if (!expectedVersion) return;
    const controller = new AbortController();
    saveRequestRef.current = controller;
    const current = () => !controller.signal.aborted && saveRequestRef.current === controller && activeFilePathRef.current === filePath;
    setSaving(true);
    setSaveProblem(null);
    try {
      const encoded = encodeFilePathForApi(filePath);
      const res = await fetch(`/api/files/${encoded}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft, expectedVersion }),
        signal: controller.signal,
      });
      const result = await res.json().catch(() => ({})) as Partial<FileData> & { error?: string; current?: FileData };
      if (!current()) return;
      if (res.status === 409) {
        // A busy writer may not return a snapshot. Read it for review only;
        // never apply the response to the editor or discard the draft.
        const disk = result.current ?? await fetch(`/api/files/${encoded}?type=read`, { signal: controller.signal }).then(r => r.ok ? r.json() : null);
        if (!current()) return;
        if (disk?.version && typeof disk.content === "string") setConflict({ ...data!, ...disk });
        setSaveProblem(t("files.saveConflict"));
        return;
      }
      if (!res.ok || result.error) {
        setSaveProblem(`${t("files.saveFailed")}: ${result.error ?? `HTTP ${res.status}`}`);
        return;
      }
      if (typeof result.content !== "string" || !result.version) throw new Error("Missing saved file revision");
      const saved = { ...data!, content: result.content, size: result.size ?? data!.size, version: result.version };
      dataRef.current = saved;
      setData(saved);
      setConflict(null);
      editingRef.current = false;
      setEditing(false);
      showToast(t("files.saved"));
    } catch (e) {
      if (current()) setSaveProblem(`${t("files.saveFailed")}: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (current()) { saveRequestRef.current = null; setSaving(false); }
    }
  }, [draft, filePath, data, editBaseVersion, conflict, t]);

  const relativePath = getRelativeFilePath(filePath, cwd);
  const outline = useMemo(() => data ? extractFileOutline(data.content, data.language) : [], [data]);
  const diagnosticLines = useMemo(() => Object.fromEntries(diagnostics.map((diagnostic) => [diagnostic.line, diagnostic.severity])) as Record<number, "error" | "warning">, [diagnostics]);
  const extension = filePath.toLowerCase().split(".").pop() ?? "";
  const structuredKind = data?.language === "json" ? "json" as const
    : data?.language === "yaml" ? "yaml" as const
      : extension === "csv" ? "csv" as const
        : extension === "tsv" ? "tsv" as const
          : null;

  const sendToAgent = useCallback((action: "explain" | "review" | "fix" | "context") => {
    if (!onSendToAgent) return;
    onSendToAgent(buildFileAgentPrompt(action, relativePath, selection));
    showToast(selection ? `${t("files.addedLines")} ${selection.startLine}–${selection.endLine}` : t("files.addedFile"), { type: "success" });
  }, [onSendToAgent, relativePath, selection, t]);

  const handleTextSelection = useCallback(() => {
    const selected = window.getSelection();
    const text = selected?.toString() ?? "";
    if (!text.trim() || !data) {
      setSelection(null);
      onViewStateChange?.({ scrollTop: contentAreaRef.current?.scrollTop ?? 0, selection: null });
      return;
    }
    const elementOf = (node: Node | null) => node instanceof Element ? node : node?.parentElement ?? null;
    const startNode = elementOf(selected?.anchorNode ?? null)?.closest("[data-line-number]");
    const endNode = elementOf(selected?.focusNode ?? null)?.closest("[data-line-number]");
    let startLine = Number(startNode?.getAttribute("data-line-number"));
    let endLine = Number(endNode?.getAttribute("data-line-number"));
    if (!startLine || !endLine) {
      const offset = data.content.indexOf(text);
      if (offset < 0) {
        setSelection(null);
        onViewStateChange?.({ scrollTop: contentAreaRef.current?.scrollTop ?? 0, selection: null });
        return;
      }
      startLine = data.content.slice(0, offset).split("\n").length;
      endLine = startLine + text.split("\n").length - 1;
    }
    if (startLine > endLine) [startLine, endLine] = [endLine, startLine];
    const nextSelection = { startLine, endLine, text };
    setSelection(nextSelection);
    onViewStateChange?.({ scrollTop: contentAreaRef.current?.scrollTop ?? 0, selection: nextSelection });
  }, [data, onViewStateChange]);

  const compareVersion = useCallback(async (commit: { sha: string; shortSha: string; subject: string }) => {
    if (!cwd) return;
    try {
      const response = await fetch(`/api/files/insights?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(relativePath)}&mode=version&ref=${encodeURIComponent(commit.sha)}`);
      const payload = await response.json() as { content?: string; error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setVersion({ ref: commit.sha, label: `${commit.shortSha} · ${commit.subject}`, content: payload.content ?? "" });
      setPreviewMode(false);
      setStructuredMode(false);
      setViewMode("diff");
    } catch (reason) { showToast(`${t("files.versionLoadFailed")}: ${reason instanceof Error ? reason.message : String(reason)}`, { type: "error" }); }
  }, [cwd, relativePath, t]);

  const compareSnapshot = useCallback(async (snapshot: { id: string; label: string }) => {
    if (!cwd || !sessionId) return;
    try {
      const response = await fetch(`/api/git/snapshots/file?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(snapshot.id)}&path=${encodeURIComponent(relativePath)}`);
      const payload = await response.json() as { content?: string; error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setVersion({ ref: snapshot.id, label: `${t("files.snapshot")} · ${snapshot.label}`, content: payload.content ?? "" });
      setPreviewMode(false); setStructuredMode(false); setViewMode("diff");
    } catch (reason) { showToast(`${t("files.snapshotLoadFailed")}: ${reason instanceof Error ? reason.message : String(reason)}`, { type: "error" }); }
  }, [cwd, relativePath, sessionId, t]);

  useEffect(() => {
    if (!fullscreen || moreOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen, moreOpen]);

  // Native <details> does not dismiss itself when another toolbar control is
  // used. Close the metadata popover on outside interaction so it never sits
  // over the second toolbar row and makes those controls feel unresponsive.
  useEffect(() => {
    const closeInfo = (event: PointerEvent) => {
      const details = fileInfoRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) {
        details.removeAttribute("open");
      }
    };
    const closeInfoWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") fileInfoRef.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeInfo, true);
    window.addEventListener("keydown", closeInfoWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeInfo, true);
      window.removeEventListener("keydown", closeInfoWithKeyboard);
    };
  }, []);

  if (loading) {
    return <div className={styles.loadingState}>{t("common.loading")}</div>;
  }

  if (error) {
    return <div className={styles.errorState}>{error}</div>;
  }

  if (!data) return null;

  const isHtml = data.language === "html";
  const isMarkdown = data.language === "markdown";
  const lines = data.content.split("\n");
  const pathParts = relativePath.split("/").filter(Boolean);
  const compactPath = pathParts.length > 2
    ? { start: pathParts[0], end: pathParts.at(-1)! }
    : null;
  const diffBase = version?.content ?? prevContent;
  const hasComparedDiff = diffBase !== null && diffBase !== data.content;

  return (
    <div className={`${styles.root} ${fullscreen ? styles.fullscreen : ""}`}>
      <div className={styles.statusBar} data-testid="file-viewer-toolbar">
        <div className={styles.fileSummary}>
          <span className={styles.filePath} title={filePath} aria-label={relativePath}>
            {compactPath
              ? <>
                  <span className={styles.filePathStart}>{compactPath.start}</span>
                  <span className={styles.filePathSeparator}>/…/</span>
                  <span className={styles.filePathEnd}>{compactPath.end}</span>
                </>
              : relativePath}
          </span>
          <details
            ref={fileInfoRef}
            className={styles.fileInfo}
            onToggle={(event) => {
              if (event.currentTarget.open) setMoreOpen(false);
            }}
          >
            <summary aria-label={t("files.info")} title={t("files.info")}>
              <Info size={14} strokeWidth={1.8} aria-hidden />
              <span>{t("files.info")}</span>
            </summary>
            <div className={styles.fileInfoPopover}>
              <span>{t("files.type")}</span><strong>{data.language}</strong>
              <span>{t("files.lines")}</span><strong>{lines.length}</strong>
              <span>{t("files.size")}</span><strong>{formatSize(data.size)}</strong>
              <span>{t("files.sync")}</span>
              <strong className={watching ? styles.watchIndicatorActive : styles.watchIndicatorInactive}>
                <span className={watching ? styles.watchDotActive : styles.watchDotInactive} />
                {t(watching ? "files.live" : "files.static")}
              </strong>
              {previewMode && previewRenderMs !== null && <>
                <span>{t("files.render")}</span><strong>{previewRenderMs} {t("files.millisecondsShort")}</strong>
              </>}
            </div>
          </details>
        </div>

        <div className={styles.fileActions}>
        {!editing && (isHtml || isMarkdown) && viewMode === "source" && (
          <div className={styles.toggleGroup} role="group" aria-label={t("files.viewMode")}>
            <button aria-pressed={!previewMode && !structuredMode} onClick={() => { setPreviewMode(false); setStructuredMode(false); }} className={`${styles.toggleGroupFirst} ${!previewMode && !structuredMode ? styles.toggleActive : styles.toggleInactive}`}>{t(isHtml ? "files.code" : "files.raw")}</button>
            <button aria-pressed={previewMode} onClick={startPreview} className={`${styles.toggleGroupSecond} ${previewMode ? styles.toggleActive : styles.toggleInactive}`}>{t("files.preview")}</button>
          </div>
        )}

        {!editing && structuredKind && viewMode === "source" && (
          <div className={styles.toggleGroup} role="group" aria-label={t("files.viewMode")}>
            <button aria-pressed={!structuredMode} onClick={() => { setStructuredMode(false); setPreviewMode(false); }} className={`${styles.toggleGroupFirst} ${!structuredMode ? styles.toggleActive : styles.toggleInactive}`}>{t("files.raw")}</button>
            <button aria-pressed={structuredMode} onClick={() => { setStructuredMode(true); setPreviewMode(false); }} className={`${styles.toggleGroupSecond} ${structuredMode ? styles.toggleActive : styles.toggleInactive}`}>{structuredKind === "csv" || structuredKind === "tsv" ? t("files.table") : t("files.tree")}</button>
          </div>
        )}

        {!editing && hasComparedDiff && (
          <div className={styles.toggleGroup} role="group" aria-label={t("files.viewMode")}>
            <button
              aria-pressed={viewMode === "source"}
              onClick={() => { setViewMode("source"); setVersion(null); }}
              className={`${styles.toggleGroupFirst} ${viewMode === "source" ? styles.toggleActive : styles.toggleInactive}`}
            >
              {t("files.source")}
            </button>
            <button
              aria-pressed={viewMode === "diff"}
              onClick={() => setViewMode("diff")}
              className={`${styles.toggleGroupSecond} ${viewMode === "diff" ? styles.toggleActive : styles.toggleInactive}`}
            >
              {version ? version.label : `${t("files.diff")}${changeCount > 0 ? ` +${changeCount}` : ""}`}
            </button>
          </div>
        )}

        {onSendToAgent && !editing && (
          <button className={styles.askPi} onClick={() => sendToAgent("context")} title={t("files.askPiHint")}>
            {t("files.askPi")}
          </button>
        )}

        {viewMode === "source" && !previewMode && !structuredMode && !data.truncated && editing && (
          <div className={styles.toggleGroup}>
            <button onClick={() => void saveEdit()} disabled={saving || Boolean(conflict)} className={`${styles.toggleGroupFirst} ${styles.toggleActive}`}>{t(saving ? "files.saving" : "files.save")}</button>
            <button onClick={() => { editingRef.current = false; setEditing(false); setDraft(""); setConflict(null); setSaveProblem(null); void fetchContent(filePath, true); }} disabled={saving} className={`${styles.toggleGroupSecond} ${styles.toggleInactive}`}>{t("common.cancel")}</button>
          </div>
        )}

        {!editing && <button className={`${styles.toggleStandalone} ${inspectorTab ? styles.toggleActive : styles.toggleInactive}`} onClick={() => setInspectorTab((current) => current ? null : "outline")} aria-expanded={Boolean(inspectorTab)}>{t("files.inspector")}</button>}
        <div className={styles.moreWrap}>
          <ActionMenu open={moreOpen} onOpenChange={setMoreOpen} label={t("files.moreActions")} trigger={
            <button type="button" className={`${styles.moreButton} ${moreOpen ? styles.toggleActive : styles.toggleInactive}`} aria-label={t("files.moreActions")}><MoreHorizontal size={17} strokeWidth={1.8} aria-hidden /></button>
          }>
            <ActionMenuItem><button onClick={copyContent}>{t("files.copyFile")}</button></ActionMenuItem>
            {viewMode === "source" && !previewMode && !structuredMode && !editing && !data.truncated && <ActionMenuItem><button disabled={!data.version} onClick={startEditing}>{t("files.editFile")}</button></ActionMenuItem>}
            {viewMode === "source" && !previewMode && !structuredMode && !editing && <ActionMenuItem><button onClick={() => setWrapLines((current) => !current)}>{t(wrapLines ? "files.disableWrap" : "files.enableWrap")}</button></ActionMenuItem>}
            {isLarge && <ActionMenuItem><button onClick={() => setForceHighlight((current) => !current)}>{t(usePlain ? "files.forceHighlight" : "files.fastPlainView")}</button></ActionMenuItem>}
            <ActionMenuItem><button onClick={() => setInspectorTab("outline")}>{t("files.inspector.outline")}</button></ActionMenuItem>
            <ActionMenuItem><button onClick={() => setInspectorTab("problems")}>{t("files.inspector.problems")}</button></ActionMenuItem>
            <ActionMenuItem><button onClick={() => setInspectorTab("history")}>{t("files.inspector.history")}</button></ActionMenuItem>
            <ActionMenuItem><button onClick={() => setInspectorTab("blame")}>{t("files.gitBlame")}</button></ActionMenuItem>
            <ActionMenuItem><button onClick={() => setInspectorTab("notes")}>{t("files.inspector.notes")}</button></ActionMenuItem>
            <ActionMenuItem><button onClick={() => setFullscreen((current) => !current)}>{t(fullscreen ? "files.exitFocus" : "files.focusMode")}</button></ActionMenuItem>
            <ActionMenuItem><a href={`/api/files/${encodeFilePathForApi(filePath)}?type=download`} download>
              {t(isHtml ? "files.downloadHtml" : isMarkdown ? "files.downloadMarkdown" : "files.downloadFile")}
            </a></ActionMenuItem>
          </ActionMenu>
        </div>
        </div>
      </div>

      {viewMode === "source" && !previewMode && !structuredMode && !editing && (
        <div className={styles.sourceTools}>
          <span className={styles.findWrap}>
            <input
              value={findQuery}
              onChange={(e) => { setFindQuery(e.target.value); setFindPos(0); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches.length > 0) { e.preventDefault(); setFindPos((p) => e.shiftKey ? (p - 1 + matches.length) % matches.length : (p + 1) % matches.length); }
                else if (e.key === "Escape") setFindQuery("");
              }}
              placeholder={t("files.findLine")}
              className={styles.findInput}
              spellCheck={false}
            />
            {findQuery.trim() && !findQuery.trim().startsWith(":") && <span className={styles.findCount}>{matches.length > 0 ? `${Math.min(findPos, matches.length - 1) + 1}/${matches.length}` : "0/0"}</span>}
          </span>
          {outline.length > 0 && <button onClick={() => setInspectorTab("outline")}>{outline.length} {t("files.symbols")}</button>}
          {wrapLines && <span>{t("files.wrapped")}</span>}
          {usePlain && <span>{t("files.largeFileMode")}</span>}
        </div>
      )}

      {selection && !editing && (
        <div className={styles.selectionBar} role="toolbar" aria-label={`${t("files.selectedLines")} ${selection.startLine}–${selection.endLine}`}>
          <strong>L{selection.startLine}{selection.endLine !== selection.startLine ? `–${selection.endLine}` : ""}</strong>
          {onSendToAgent && <><button onClick={() => sendToAgent("explain")}>{t("files.explain")}</button><button onClick={() => sendToAgent("review")}>{t("files.review")}</button><button onClick={() => sendToAgent("fix")}>{t("files.fix")}</button><button onClick={() => sendToAgent("context")}>{t("files.addToPrompt")}</button></>}
          <button className={styles.selectionClose} onClick={() => { window.getSelection()?.removeAllRanges(); setSelection(null); onViewStateChange?.({ scrollTop: contentAreaRef.current?.scrollTop ?? 0, selection: null }); }} aria-label={t("files.clearSelection")}>×</button>
        </div>
      )}

      {/* Partial-preview banner: the API returned only the file's first chunk */}
      {data.truncated && (
        <div className={styles.truncatedNotice}>
          {t("files.largeFilePrefix")} ({formatSize(data.size)}) — {t("files.largeFileNotice")}{" "}
          <a href={`/api/files/${encodeFilePathForApi(filePath)}?type=download`} download>{t("files.downloadFull")}</a>
        </div>
      )}

      {isHtml && previewMode && viewMode === "source" && !editing && (
        <details className={styles.previewNotice}>
          <summary>{t("files.isolatedPreview")}</summary>
          <p>{t("files.isolatedPreviewHelp")}</p>
        </details>
      )}

      <div className={styles.workspaceBody}>
      <div
        ref={contentAreaRef}
        className={styles.contentArea}
        onPointerDownCapture={stopRestoringView}
        onTouchStartCapture={stopRestoringView}
        onWheelCapture={stopRestoringView}
        onPointerUp={handleTextSelection}
        onScroll={(event) => {
          if (!onViewStateChange || restoringViewRef.current) return;
          const scrollTop = event.currentTarget.scrollTop;
          if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
          scrollSaveTimerRef.current = setTimeout(() => onViewStateChange({ scrollTop, selection }), 120);
        }}
      >
        {editing ? (
          <div className={styles.editWorkspace}>
          {saveProblem && <div className={styles.saveProblem} role="status">{saveProblem}</div>}
          {conflict && <section className={styles.saveConflict} aria-label={t("files.conflictReview")}>
            <details open>
              <summary>{t("files.conflictReview")}</summary>
              <p>{t("files.conflictHelp")}</p>
              <div className={styles.conflictDiff}><DiffViewMode oldContent={conflict.content} newContent={draft} language={data.language} /></div>
            </details>
            <div className={styles.conflictActions}>
              <button disabled={saving} onClick={() => { dataRef.current = conflict; setData(conflict); setDraft(conflict.content); setEditBaseVersion(conflict.version ?? null); setConflict(null); setSaveProblem(null); }}>{t("files.useDiskVersion")}</button>
              <button disabled={saving} onClick={() => void saveEdit(conflict.version)}>{t("files.saveReviewedDraft")}</button>
            </div>
          </section>}
          <textarea
            value={draft}
            readOnly={saving}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void saveEdit(); }
            }}
            className={styles.editor}
            spellCheck={false}
            aria-label={t("files.editor")}
          />
          </div>
        ) : viewMode === "diff" && hasComparedDiff ? (
          <DiffViewMode oldContent={diffBase!} newContent={data.content} language={data.language} />
        ) : structuredMode && structuredKind ? (
          <StructuredDataView content={data.content} kind={structuredKind} onGotoLine={(line) => { setStructuredMode(false); setFindQuery(`:${line}`); }} />
        ) : (isHtml || isMarkdown) && previewMode ? (
          <Suspense fallback={<div className={styles.previewLoading}>{t("files.renderingPreview")}</div>}>
            <LazyPreviewView content={data.content} language={data.language} filePath={filePath} onRendered={handlePreviewRendered} />
          </Suspense>
        ) : usePlain ? (
          <PlainSourceView content={data.content} activeLine={activeLine} diagnosticLines={diagnosticLines} />
        ) : (
          <SourceView content={data.content} language={data.language} wrapLines={wrapLines} activeLine={activeLine} diagnosticLines={diagnosticLines} />
        )}
      </div>
      {inspectorTab && <FileInspectorDrawer
        filePath={filePath}
        relativePath={relativePath}
        cwd={cwd}
        sessionId={sessionId}
        outline={outline}
        initialTab={inspectorTab}
        onClose={() => setInspectorTab(null)}
        onGotoLine={(line) => { setViewMode("source"); setPreviewMode(false); setStructuredMode(false); setFindQuery(`:${line}`); }}
        onCompareVersion={(commit) => void compareVersion(commit)}
        onCompareSnapshot={(snapshot) => void compareSnapshot(snapshot)}
        onDiagnosticsLoaded={(items) => setDiagnostics(items)}
        onSendDiagnostic={onSendToAgent ? (diagnostic) => onSendToAgent(buildFileAgentPrompt("diagnostic", relativePath, { startLine: diagnostic.line, endLine: diagnostic.line, text: data.content.split("\n")[diagnostic.line - 1] ?? "" }, `${diagnostic.code ?? diagnostic.source}: ${diagnostic.message}`)) : undefined}
      />}
      </div>
    </div>
  );
}
