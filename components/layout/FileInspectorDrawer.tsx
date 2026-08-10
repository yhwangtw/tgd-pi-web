"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileOutlineItem } from "@/lib/file-workbench";
import styles from "./FileInspectorDrawer.module.css";

type InspectorTab = "outline" | "problems" | "history" | "blame" | "notes";
interface Diagnostic { source: "typescript" | "eslint" | "test"; line: number; column: number; severity: "error" | "warning"; code?: string; message: string }
interface Commit { sha: string; shortSha: string; author: string; date: string; subject: string }
interface BlameLine { line: number; sha: string; author: string; date: string; text: string }
interface FileNote { id: string; line: number; text: string; createdAt: number }
interface Snapshot { id: string; ts: number; label: string; fileCount: number }

interface Props {
  filePath: string;
  relativePath: string;
  cwd?: string;
  sessionId?: string | null;
  outline: FileOutlineItem[];
  initialTab?: InspectorTab;
  onClose: () => void;
  onGotoLine: (line: number) => void;
  onCompareVersion: (commit: Commit) => void;
  onCompareSnapshot?: (snapshot: Snapshot) => void;
  onSendDiagnostic?: (diagnostic: Diagnostic) => void;
  onDiagnosticsLoaded?: (diagnostics: Diagnostic[]) => void;
}

function noteKey(filePath: string) { return `pi-file-notes:${filePath}`; }
function readNotes(filePath: string): FileNote[] {
  try { const parsed = JSON.parse(localStorage.getItem(noteKey(filePath)) ?? "[]") as FileNote[]; return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

export function FileInspectorDrawer({ filePath, relativePath, cwd, sessionId, outline, initialTab = "outline", onClose, onGotoLine, onCompareVersion, onCompareSnapshot, onSendDiagnostic, onDiagnosticsLoaded }: Props) {
  const [tab, setTab] = useState<InspectorTab>(initialTab);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[] | null>(null);
  const [history, setHistory] = useState<Commit[] | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [blame, setBlame] = useState<BlameLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [runningTests, setRunningTests] = useState(false);
  const [notes, setNotes] = useState<FileNote[]>(() => typeof window === "undefined" ? [] : readNotes(filePath));
  const [noteLine, setNoteLine] = useState("1");
  const [noteText, setNoteText] = useState("");

  useEffect(() => { setTab(initialTab); }, [initialTab]);
  useEffect(() => { setNotes(readNotes(filePath)); setDiagnostics(null); setHistory(null); setBlame(null); }, [filePath]);
  const endpoint = useCallback((mode: InspectorTab) => `/api/files/insights?cwd=${encodeURIComponent(cwd ?? "")}&path=${encodeURIComponent(relativePath)}&mode=${mode === "problems" ? "diagnostics" : mode}`, [cwd, relativePath]);

  useEffect(() => {
    if (!cwd || tab === "outline" || tab === "notes") return;
    if ((tab === "problems" && diagnostics) || (tab === "history" && history) || (tab === "blame" && blame)) return;
    const controller = new AbortController();
    setLoading(true); setError("");
    const mainRequest = fetch(endpoint(tab), { signal: controller.signal });
    const snapshotsRequest = tab === "history" && sessionId
      ? fetch(`/api/git/snapshots?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      : null;
    Promise.all([mainRequest, snapshotsRequest]).then(async ([response, snapshotResponse]) => {
      const data = await response.json() as { diagnostics?: Diagnostic[]; commits?: Commit[]; lines?: BlameLine[]; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (tab === "problems") { const next = data.diagnostics ?? []; setDiagnostics(next); onDiagnosticsLoaded?.(next); }
      if (tab === "history") {
        setHistory(data.commits ?? []);
        if (snapshotResponse?.ok) {
          const snapshotData = await snapshotResponse.json() as { snapshots?: Snapshot[] };
          setSnapshots(snapshotData.snapshots ?? []);
        } else setSnapshots([]);
      }
      if (tab === "blame") setBlame(data.lines ?? []);
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [blame, cwd, diagnostics, endpoint, history, onDiagnosticsLoaded, sessionId, tab]);

  const groupedBlame = useMemo(() => {
    if (!blame) return [];
    const out: Array<BlameLine & { count: number }> = [];
    for (const line of blame) {
      const last = out[out.length - 1];
      if (last?.sha === line.sha && last.line + last.count === line.line) last.count++;
      else out.push({ ...line, count: 1 });
    }
    return out;
  }, [blame]);

  const saveNotes = (next: FileNote[]) => { setNotes(next); localStorage.setItem(noteKey(filePath), JSON.stringify(next)); };
  const runRelatedTests = async () => {
    if (!cwd || runningTests) return;
    setRunningTests(true); setError("");
    try {
      const response = await fetch(`/api/files/insights?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(relativePath)}&mode=tests`);
      const payload = await response.json() as { diagnostics?: Diagnostic[]; error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      const next = [...(diagnostics ?? []).filter((item) => item.source !== "test"), ...(payload.diagnostics ?? [])];
      setDiagnostics(next); onDiagnosticsLoaded?.(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRunningTests(false); }
  };

  return (
    <div className={styles.drawer} role="complementary" aria-label="File inspector" data-testid="file-inspector">
      <div className={styles.header}><strong>Inspector</strong><button onClick={onClose} aria-label="Close inspector">×</button></div>
      <div className={styles.tabs} role="tablist">
        {(["outline", "problems", "history", "blame", "notes"] as InspectorTab[]).map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? styles.tabActive : styles.tab} onClick={() => setTab(item)}>{item === "outline" ? "Outline" : item === "problems" ? `Problems${diagnostics?.length ? ` ${diagnostics.length}` : ""}` : item[0].toUpperCase() + item.slice(1)}</button>)}
      </div>
      <div className={styles.body}>
        {loading && <div className={styles.empty}>Loading…</div>}
        {error && <div className={styles.error}>{error}</div>}
        {!loading && !error && tab === "outline" && (outline.length ? <div className={styles.list}>{outline.map((item) => <button key={item.id} className={styles.row} style={{ paddingLeft: 10 + (item.level - 1) * 14 }} onClick={() => onGotoLine(item.line)}><span className={styles.kind}>{item.kind.slice(0, 2)}</span><span className={styles.label}>{item.label}</span><span className={styles.line}>L{item.line}</span></button>)}</div> : <div className={styles.empty}>No symbols found</div>)}
        {!loading && !error && tab === "problems" && <div className={styles.problemsPane}>
          <div className={styles.problemActions}><span>TypeScript · ESLint · related tests</span><button disabled={runningTests} onClick={() => void runRelatedTests()}>{runningTests ? "Running…" : "Run related tests"}</button></div>
          {diagnostics?.length ? <div className={styles.list}>{diagnostics.map((item, index) => <div key={`${item.source}-${item.line}-${index}`} className={styles.problem}><button className={styles.problemMain} onClick={() => onGotoLine(item.line)}><span className={item.severity === "error" ? styles.problemError : styles.problemWarning}>{item.severity === "error" ? "●" : "▲"}</span><span><strong>{item.code ?? item.source}</strong> {item.message}</span><span className={styles.line}>{item.source === "test" ? "test" : `L${item.line}:${item.column}`}</span></button>{onSendDiagnostic && <button className={styles.fix} onClick={() => onSendDiagnostic(item)}>Ask Pi to fix</button>}</div>)}</div> : diagnostics && <div className={styles.empty}>No TypeScript, ESLint, or test problems</div>}
        </div>}
        {!loading && !error && tab === "history" && <div className={styles.list}>
          {snapshots.length > 0 && <><div className={styles.groupLabel}>Agent snapshots</div>{snapshots.map((snapshot) => <button key={snapshot.id} className={styles.commit} onClick={() => onCompareSnapshot?.(snapshot)}><span className={styles.sha}>snap</span><span className={styles.label}>{snapshot.label}</span><span className={styles.meta}>{new Date(snapshot.ts).toLocaleString()} · {snapshot.fileCount} files</span></button>)}</>}
          {(history?.length ?? 0) > 0 && <><div className={styles.groupLabel}>Git history</div>{history!.map((commit) => <button key={commit.sha} className={styles.commit} onClick={() => onCompareVersion(commit)}><span className={styles.sha}>{commit.shortSha}</span><span className={styles.label}>{commit.subject}</span><span className={styles.meta}>{commit.author} · {new Date(commit.date).toLocaleDateString()}</span></button>)}</>}
          {history && history.length === 0 && snapshots.length === 0 && <div className={styles.empty}>No history for this file</div>}
        </div>}
        {!loading && !error && tab === "blame" && (groupedBlame.length ? <div className={styles.list}>{groupedBlame.map((item) => <button key={`${item.sha}-${item.line}`} className={styles.commit} onClick={() => onGotoLine(item.line)}><span className={styles.sha}>{item.sha.slice(0, 8)}</span><span className={styles.label}>{item.author}</span><span className={styles.meta}>L{item.line}–{item.line + item.count - 1} · {new Date(item.date).toLocaleDateString()}</span></button>)}</div> : blame && <div className={styles.empty}>Blame is unavailable</div>)}
        {tab === "notes" && <div className={styles.notes}><form onSubmit={(event) => { event.preventDefault(); const text = noteText.trim(); const line = Number(noteLine); if (!text || !Number.isFinite(line) || line < 1) return; saveNotes([...notes, { id: crypto.randomUUID(), line, text, createdAt: Date.now() }]); setNoteText(""); }}><div className={styles.noteForm}><input aria-label="Line" value={noteLine} onChange={(event) => setNoteLine(event.target.value)} inputMode="numeric" /><textarea aria-label="Note" value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="Comment or review note…" rows={2} /><button disabled={!noteText.trim()}>Add</button></div></form>{notes.map((note) => <div className={styles.note} key={note.id}><button onClick={() => onGotoLine(note.line)}>L{note.line}</button><span>{note.text}</span><button aria-label="Delete note" onClick={() => saveNotes(notes.filter((item) => item.id !== note.id))}>×</button></div>)}</div>}
      </div>
    </div>
  );
}
