"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { encodeFilePathForApi, getRelativeFilePath } from "@/lib/file-paths";
import { useFileWatch } from "@/hooks/useFileWatch";
import { formatSize, type FileData } from "./file-viewer-utils";
import { SourceView } from "./text-viewer/SourceView";
import { PlainSourceView } from "./text-viewer/PlainSourceView";
import { DiffViewMode } from "./text-viewer/DiffViewMode";
import { PreviewView } from "./text-viewer/PreviewView";
import { StructuredDataView } from "./text-viewer/StructuredDataView";
import { FileInspectorDrawer } from "./FileInspectorDrawer";
import { buildFileAgentPrompt, extractFileOutline, type TextSelectionRange } from "@/lib/file-workbench";
import { showToast } from "@/hooks/useToast";
import styles from "./TextFileViewer.module.css";

interface Props {
  filePath: string;
  cwd?: string;
  /** Jump to this 1-based line on open (from a search hit). */
  gotoLine?: number;
  /** Bumped per jump request, so reopening an open file re-triggers the jump. */
  gotoNonce?: number;
  onSendToAgent?: (prompt: string) => void;
  sessionId?: string | null;
}

type InspectorTab = "outline" | "problems" | "history" | "blame" | "notes";

export function TextFileViewer({ filePath, cwd, gotoLine: gotoLineProp, gotoNonce, onSendToAgent, sessionId }: Props) {
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
  const [selection, setSelection] = useState<TextSelectionRange | null>(null);
  const [version, setVersion] = useState<{ ref: string; label: string; content: string } | null>(null);
  const [diagnostics, setDiagnostics] = useState<Array<{ line: number; severity: "error" | "warning" }>>([]);
  const { watching, refreshTrigger } = useFileWatch(filePath);

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
  const [saving, setSaving] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const fetchContent = useCallback((filePath: string, isRefresh = false) => {
    const encoded = encodeFilePathForApi(filePath);
    return fetch(`/api/files/${encoded}?type=read`)
      .then((r) => r.json())
      .then((d: FileData & { error?: string }) => {
        if (d.error) {
          setError(d.error);
          return null;
        }
        if (isRefresh) {
          setData((prev) => {
            if (prev) setPrevContent(prev.content);
            return d;
          });
          setChangeCount((c) => c + 1);
        } else {
          setData(d);
        }
        return d;
      })
      .catch((e) => {
        setError(String(e));
        return null;
      });
  }, []);

  // Initial load
  useEffect(() => {
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
      if (d?.language === "markdown") setPreviewMode(true);
    }).finally(() => setLoading(false));
  }, [filePath, fetchContent]);

  // Refresh on file-watch change events — debounced 300ms so an agent
  // writing in bursts triggers one reload, and never clobber an open editor.
  useEffect(() => {
    if (refreshTrigger === 0) return;
    const t = setTimeout(() => {
      if (!editingRef.current) fetchContent(filePath, true);
    }, 300);
    return () => clearTimeout(t);
  }, [refreshTrigger, filePath, fetchContent]);

  // Reset transient tool state when switching files
  useEffect(() => {
    setFindQuery("");
    setFindPos(0);
    setEditing(false);
    setDraft("");
    setForceHighlight(false);
    setMoreOpen(false);
    setSelection(null);
    setVersion(null);
  }, [filePath]);

  // Jump to a line requested by a search hit. Reuses the ":N" go-to-line path
  // (seeds the find box), so the existing active-line scroll handles it. Keyed
  // on gotoNonce so reopening an already-open file at a new line re-fires.
  // Declared after the reset effect above so it wins on a fresh open.
  useEffect(() => {
    if (gotoLineProp && gotoLineProp > 0) setFindQuery(`:${gotoLineProp}`);
  }, [gotoLineProp, gotoNonce]);

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
      .then(() => showToast("Copied file contents"))
      .catch(() => {});
  }, [data]);

  const startEditing = useCallback(() => {
    if (!data) return;
    setDraft(data.content);
    setEditing(true);
    setFindQuery("");
  }, [data]);

  const saveEdit = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const encoded = encodeFilePathForApi(filePath);
      const res = await fetch(`/api/files/${encoded}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      const result = await res.json().catch(() => ({})) as { error?: string; size?: number };
      if (!res.ok || result.error) {
        showToast(`Save failed: ${result.error ?? `HTTP ${res.status}`}`, { type: "error" });
        return;
      }
      setData((prev) => (prev ? { ...prev, content: draft, size: result.size ?? prev.size } : prev));
      setEditing(false);
      showToast("Saved");
    } catch (e) {
      showToast(`Save failed: ${e instanceof Error ? e.message : e}`, { type: "error" });
    } finally {
      setSaving(false);
    }
  }, [draft, filePath, saving]);

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
    showToast(selection ? `Added lines ${selection.startLine}–${selection.endLine} to the prompt` : "Added file to the prompt", { type: "success" });
  }, [onSendToAgent, relativePath, selection]);

  const handleTextSelection = useCallback(() => {
    const selected = window.getSelection();
    const text = selected?.toString() ?? "";
    if (!text.trim() || !data) { setSelection(null); return; }
    const elementOf = (node: Node | null) => node instanceof Element ? node : node?.parentElement ?? null;
    const startNode = elementOf(selected?.anchorNode ?? null)?.closest("[data-line-number]");
    const endNode = elementOf(selected?.focusNode ?? null)?.closest("[data-line-number]");
    let startLine = Number(startNode?.getAttribute("data-line-number"));
    let endLine = Number(endNode?.getAttribute("data-line-number"));
    if (!startLine || !endLine) {
      const offset = data.content.indexOf(text);
      if (offset < 0) { setSelection(null); return; }
      startLine = data.content.slice(0, offset).split("\n").length;
      endLine = startLine + text.split("\n").length - 1;
    }
    if (startLine > endLine) [startLine, endLine] = [endLine, startLine];
    setSelection({ startLine, endLine, text });
  }, [data]);

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
    } catch (reason) { showToast(`Version load failed: ${reason instanceof Error ? reason.message : String(reason)}`, { type: "error" }); }
  }, [cwd, relativePath]);

  const compareSnapshot = useCallback(async (snapshot: { id: string; label: string }) => {
    if (!cwd || !sessionId) return;
    try {
      const response = await fetch(`/api/git/snapshots/file?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(snapshot.id)}&path=${encodeURIComponent(relativePath)}`);
      const payload = await response.json() as { content?: string; error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setVersion({ ref: snapshot.id, label: `Snapshot · ${snapshot.label}`, content: payload.content ?? "" });
      setPreviewMode(false); setStructuredMode(false); setViewMode("diff");
    } catch (reason) { showToast(`Snapshot load failed: ${reason instanceof Error ? reason.message : String(reason)}`, { type: "error" }); }
  }, [cwd, relativePath, sessionId]);

  useEffect(() => {
    if (!fullscreen && !moreOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { setFullscreen(false); setMoreOpen(false); } };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen, moreOpen]);

  if (loading) {
    return <div className={styles.loadingState}>Loading...</div>;
  }

  if (error) {
    return <div className={styles.errorState}>{error}</div>;
  }

  if (!data) return null;

  const isHtml = data.language === "html";
  const isMarkdown = data.language === "markdown";
  const lines = data.content.split("\n");
  const diffBase = version?.content ?? prevContent;
  const hasComparedDiff = diffBase !== null && diffBase !== data.content;

  return (
    <div className={`${styles.root} ${fullscreen ? styles.fullscreen : ""}`}>
      <div className={styles.statusBar} data-testid="file-viewer-toolbar">
        <div className={styles.fileSummary}>
          <span className={styles.filePath} title={filePath}>
            {relativePath}
          </span>
          <span className={styles.fileMeta}>
            <span className={styles.language}>{data.language}</span>
            {viewMode === "source" && !structuredMode && <span>{lines.length} lines</span>}
            <span>{formatSize(data.size)}</span>

            {/* Live watch indicator */}
            <span
              title={watching ? "Live sync active" : "Not watching"}
              className={watching ? styles.watchIndicatorActive : styles.watchIndicatorInactive}
            >
              <span className={watching ? styles.watchDotActive : styles.watchDotInactive} />
              {watching ? "live" : "static"}
            </span>
          </span>
        </div>

        <div className={styles.fileActions}>
        {onSendToAgent && !editing && (
          <button className={styles.askPi} onClick={() => sendToAgent("context")} title="Add this file or selected lines to the composer">
            Ask Pi
          </button>
        )}

        {(isHtml || isMarkdown) && viewMode === "source" && (
          <div className={styles.toggleGroup}>
            <button onClick={() => { setPreviewMode(false); setStructuredMode(false); }} className={`${styles.toggleGroupFirst} ${!previewMode && !structuredMode ? styles.toggleActive : styles.toggleInactive}`}>{isHtml ? "Code" : "Raw"}</button>
            <button onClick={() => { setPreviewMode(true); setStructuredMode(false); }} className={`${styles.toggleGroupSecond} ${previewMode ? styles.toggleActive : styles.toggleInactive}`}>Preview</button>
          </div>
        )}

        {structuredKind && viewMode === "source" && (
          <div className={styles.toggleGroup}>
            <button onClick={() => { setStructuredMode(false); setPreviewMode(false); }} className={`${styles.toggleGroupFirst} ${!structuredMode ? styles.toggleActive : styles.toggleInactive}`}>Raw</button>
            <button onClick={() => { setStructuredMode(true); setPreviewMode(false); }} className={`${styles.toggleGroupSecond} ${structuredMode ? styles.toggleActive : styles.toggleInactive}`}>{structuredKind === "csv" || structuredKind === "tsv" ? "Table" : "Tree"}</button>
          </div>
        )}

        {hasComparedDiff && (
          <div className={styles.toggleGroup}>
            <button
              onClick={() => { setViewMode("source"); setVersion(null); }}
              className={`${styles.toggleGroupFirst} ${viewMode === "source" ? styles.toggleActive : styles.toggleInactive}`}
            >
              Source
            </button>
            <button
              onClick={() => setViewMode("diff")}
              className={`${styles.toggleGroupSecond} ${viewMode === "diff" ? styles.toggleActive : styles.toggleInactive}`}
            >
              {version ? version.label : `Diff${changeCount > 0 ? ` +${changeCount}` : ""}`}
            </button>
          </div>
        )}

        {viewMode === "source" && !previewMode && !structuredMode && !data.truncated && editing && (
          <div className={styles.toggleGroup}>
            <button onClick={() => void saveEdit()} disabled={saving} className={`${styles.toggleGroupFirst} ${styles.toggleActive}`}>{saving ? "Saving…" : "Save"}</button>
            <button onClick={() => { setEditing(false); setDraft(""); }} disabled={saving} className={`${styles.toggleGroupSecond} ${styles.toggleInactive}`}>Cancel</button>
          </div>
        )}

        {!editing && <button className={`${styles.toggleStandalone} ${inspectorTab ? styles.toggleActive : styles.toggleInactive}`} onClick={() => setInspectorTab((current) => current ? null : "outline")} aria-expanded={Boolean(inspectorTab)}>Inspector</button>}
        <div className={styles.moreWrap}>
          <button className={`${styles.moreButton} ${moreOpen ? styles.toggleActive : styles.toggleInactive}`} onClick={() => setMoreOpen((current) => !current)} aria-label="More file actions" aria-expanded={moreOpen}>•••</button>
          {moreOpen && <><button className={styles.menuBackdrop} aria-label="Close menu" onClick={() => setMoreOpen(false)} /><div className={styles.moreMenu} role="menu">
            <button onClick={() => { copyContent(); setMoreOpen(false); }}>Copy file</button>
            {viewMode === "source" && !previewMode && !structuredMode && !editing && !data.truncated && <button onClick={() => { startEditing(); setMoreOpen(false); }}>Edit file</button>}
            {viewMode === "source" && !previewMode && !structuredMode && !editing && <button onClick={() => { setWrapLines((current) => !current); setMoreOpen(false); }}>{wrapLines ? "Disable" : "Enable"} word wrap</button>}
            {isLarge && <button onClick={() => { setForceHighlight((current) => !current); setMoreOpen(false); }}>{usePlain ? "Force syntax highlighting" : "Use fast plain view"}</button>}
            <button onClick={() => { setInspectorTab("outline"); setMoreOpen(false); }}>Outline</button>
            <button onClick={() => { setInspectorTab("problems"); setMoreOpen(false); }}>Problems</button>
            <button onClick={() => { setInspectorTab("history"); setMoreOpen(false); }}>History</button>
            <button onClick={() => { setInspectorTab("blame"); setMoreOpen(false); }}>Git blame</button>
            <button onClick={() => { setInspectorTab("notes"); setMoreOpen(false); }}>Notes</button>
            <button onClick={() => { setFullscreen((current) => !current); setMoreOpen(false); }}>{fullscreen ? "Exit focus mode" : "Focus mode"}</button>
            <a href={`/api/files/${encodeFilePathForApi(filePath)}?type=download`} download>Download</a>
          </div></>}
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
              placeholder="find / :line"
              className={styles.findInput}
              spellCheck={false}
            />
            {findQuery.trim() && !findQuery.trim().startsWith(":") && <span className={styles.findCount}>{matches.length > 0 ? `${Math.min(findPos, matches.length - 1) + 1}/${matches.length}` : "0/0"}</span>}
          </span>
          {outline.length > 0 && <button onClick={() => setInspectorTab("outline")}>{outline.length} symbols</button>}
          {wrapLines && <span>wrapped</span>}
          {usePlain && <span>large-file mode</span>}
        </div>
      )}

      {selection && !editing && (
        <div className={styles.selectionBar} role="toolbar" aria-label={`Selected lines ${selection.startLine} to ${selection.endLine}`}>
          <strong>L{selection.startLine}{selection.endLine !== selection.startLine ? `–${selection.endLine}` : ""}</strong>
          {onSendToAgent && <><button onClick={() => sendToAgent("explain")}>Explain</button><button onClick={() => sendToAgent("review")}>Review</button><button onClick={() => sendToAgent("fix")}>Fix</button><button onClick={() => sendToAgent("context")}>Add to prompt</button></>}
          <button className={styles.selectionClose} onClick={() => { window.getSelection()?.removeAllRanges(); setSelection(null); }} aria-label="Clear selection">×</button>
        </div>
      )}

      {/* Partial-preview banner: the API returned only the file's first chunk */}
      {data.truncated && (
        <div className={styles.truncatedNotice}>
          Large file ({formatSize(data.size)}) — showing the beginning only; editing disabled.{" "}
          <a href={`/api/files/${encodeFilePathForApi(filePath)}?type=download`} download>Download the full file</a>
        </div>
      )}

      <div className={styles.workspaceBody}>
      <div className={styles.contentArea} onPointerUp={handleTextSelection}>
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void saveEdit(); }
            }}
            className={styles.editor}
            spellCheck={false}
            aria-label="File editor"
          />
        ) : viewMode === "diff" && hasComparedDiff ? (
          <DiffViewMode oldContent={diffBase!} newContent={data.content} language={data.language} />
        ) : structuredMode && structuredKind ? (
          <StructuredDataView content={data.content} kind={structuredKind} onGotoLine={(line) => { setStructuredMode(false); setFindQuery(`:${line}`); }} />
        ) : (isHtml || isMarkdown) && previewMode ? (
          <PreviewView content={data.content} language={data.language} filePath={filePath} />
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
