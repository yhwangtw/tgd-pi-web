"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileOutlineItem } from "@/lib/file-workbench";
import { useI18n, type MsgKey } from "@/lib/i18n";
import styles from "./FileInspectorDrawer.module.css";
import { requestOpenFile } from "@/lib/file-links";

type InspectorTab = "outline" | "problems" | "history" | "blame" | "notes";
interface Diagnostic { source: "typescript" | "eslint" | "test"; line: number; column: number; severity: "error" | "warning"; code?: string; message: string }
interface Commit { sha: string; shortSha: string; author: string; date: string; subject: string }
interface BlameLine { line: number; sha: string; author: string; date: string; text: string }
interface FileNote { id: string; line: number; text: string; createdAt: number }
interface Snapshot {
  id: string;
  ts: number;
  label: string;
  fileCount: number;
  impact?: { total: number };
}
interface SymbolMatch { path: string; line: number; preview: string }

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
  const { t } = useI18n();
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
  const [symbol, setSymbol] = useState("");
  const [symbolMode, setSymbolMode] = useState<"definition" | "references">("definition");
  const [symbolMatches, setSymbolMatches] = useState<SymbolMatch[] | null>(null);
  const tabKeys: Record<InspectorTab, MsgKey> = {
    outline: "files.inspector.outline",
    problems: "files.inspector.problems",
    history: "files.inspector.history",
    blame: "files.inspector.blame",
    notes: "files.inspector.notes",
  };

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

  const findSymbol = async (mode: "definition" | "references") => {
    if (!cwd || !symbol.trim()) return;
    setLoading(true); setError(""); setSymbolMode(mode);
    try {
      const response = await fetch(`${endpoint("outline")}&mode=${mode}&symbol=${encodeURIComponent(symbol.trim())}`);
      const payload = await response.json() as { matches?: SymbolMatch[]; error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setSymbolMatches(payload.matches ?? []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };

  return (
    <div className={styles.drawer} role="complementary" aria-label={t("files.inspector.title")} data-testid="file-inspector">
      <div className={styles.header}><strong>{t("files.inspector.title")}</strong><button onClick={onClose} aria-label={t("files.inspector.close")}>×</button></div>
      <div className={styles.tabs} role="tablist">
        {(["outline", "problems", "history", "blame", "notes"] as InspectorTab[]).map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? styles.tabActive : styles.tab} onClick={() => setTab(item)}>{t(tabKeys[item])}{item === "problems" && diagnostics?.length ? ` ${diagnostics.length}` : ""}</button>)}
      </div>
      <div className={styles.body}>
        {loading && <div className={styles.empty}>{t("common.loading")}</div>}
        {error && <div className={styles.error}>{error}</div>}
        {!loading && !error && tab === "outline" && <>
          <form className={styles.symbolSearch} onSubmit={(event) => { event.preventDefault(); void findSymbol("definition"); }}>
            <input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder={t("files.inspector.findSymbol")} aria-label={t("files.inspector.symbol")} />
            <button type="submit" disabled={!symbol.trim()}>{t("files.inspector.definition")}</button>
            <button type="button" disabled={!symbol.trim()} onClick={() => void findSymbol("references")}>{t("files.inspector.references")}</button>
          </form>
          {symbolMatches && <div className={styles.list} aria-label={t(symbolMode === "definition" ? "files.inspector.definitionResults" : "files.inspector.referenceResults")}>
            {symbolMatches.length === 0 ? <div className={styles.empty}>{t(symbolMode === "definition" ? "files.inspector.noDefinition" : "files.inspector.noReferences")}</div> : symbolMatches.map((match, index) => <button key={`${match.path}:${match.line}:${index}`} className={styles.symbolResult} onClick={() => match.path === relativePath ? onGotoLine(match.line) : requestOpenFile({ path: match.path, line: match.line })}><span className="chrome-mono">{match.path}:{match.line}</span><span>{match.preview}</span></button>)}
          </div>}
          {outline.length ? <div className={styles.list}>{outline.map((item) => <button key={item.id} className={styles.row} style={{ paddingLeft: 10 + (item.level - 1) * 14 }} onClick={() => onGotoLine(item.line)}><span className={styles.kind}>{item.kind.slice(0, 2)}</span><span className={styles.label}>{item.label}</span><span className={styles.line}>L{item.line}</span></button>)}</div> : !symbolMatches && <div className={styles.empty}>{t("files.inspector.noSymbols")}</div>}
        </>}
        {!loading && !error && tab === "problems" && <div className={styles.problemsPane}>
          <div className={styles.problemActions}><span>{t("files.inspector.problemSources")}</span><button disabled={runningTests} onClick={() => void runRelatedTests()}>{t(runningTests ? "files.inspector.runningTests" : "files.inspector.runTests")}</button></div>
          {diagnostics?.length ? <div className={styles.list}>{diagnostics.map((item, index) => <div key={`${item.source}-${item.line}-${index}`} className={styles.problem}><button className={styles.problemMain} onClick={() => onGotoLine(item.line)}><span className={item.severity === "error" ? styles.problemError : styles.problemWarning}>{item.severity === "error" ? "●" : "▲"}</span><span><strong>{item.code ?? item.source}</strong> {item.message}</span><span className={styles.line}>{item.source === "test" ? "test" : `L${item.line}:${item.column}`}</span></button>{onSendDiagnostic && <button className={styles.fix} onClick={() => onSendDiagnostic(item)}>{t("files.inspector.askPiFix")}</button>}</div>)}</div> : diagnostics && <div className={styles.empty}>{t("files.inspector.noProblems")}</div>}
        </div>}
        {!loading && !error && tab === "history" && <div className={styles.list}>
          {snapshots.length > 0 && <><div className={styles.groupLabel}>{t("files.inspector.snapshots")}</div>{snapshots.map((snapshot) => <button type="button" key={snapshot.id} className={styles.commit} onClick={() => onCompareSnapshot?.(snapshot)}><span className={styles.sha}>{t("files.inspector.snapshotShort")}</span><span className={styles.label}>{snapshot.label}</span><span className={styles.meta}>{new Date(snapshot.ts).toLocaleString()} · {snapshot.impact?.total ?? snapshot.fileCount} {t("files.inspector.affected")}</span></button>)}</>}
          {(history?.length ?? 0) > 0 && <><div className={styles.groupLabel}>{t("files.inspector.gitHistory")}</div>{history!.map((commit) => <button key={commit.sha} className={styles.commit} onClick={() => onCompareVersion(commit)}><span className={styles.sha}>{commit.shortSha}</span><span className={styles.label}>{commit.subject}</span><span className={styles.meta}>{commit.author} · {new Date(commit.date).toLocaleDateString()}</span></button>)}</>}
          {history && history.length === 0 && snapshots.length === 0 && <div className={styles.empty}>{t("files.inspector.noHistory")}</div>}
        </div>}
        {!loading && !error && tab === "blame" && (groupedBlame.length ? <div className={styles.list}>{groupedBlame.map((item) => <button key={`${item.sha}-${item.line}`} className={styles.commit} onClick={() => onGotoLine(item.line)}><span className={styles.sha}>{item.sha.slice(0, 8)}</span><span className={styles.label}>{item.author}</span><span className={styles.meta}>L{item.line}–{item.line + item.count - 1} · {new Date(item.date).toLocaleDateString()}</span></button>)}</div> : blame && <div className={styles.empty}>{t("files.inspector.blameUnavailable")}</div>)}
        {tab === "notes" && <div className={styles.notes}><form onSubmit={(event) => { event.preventDefault(); const text = noteText.trim(); const line = Number(noteLine); if (!text || !Number.isFinite(line) || line < 1) return; saveNotes([...notes, { id: crypto.randomUUID(), line, text, createdAt: Date.now() }]); setNoteText(""); }}><div className={styles.noteForm}><input aria-label={t("files.inspector.line")} value={noteLine} onChange={(event) => setNoteLine(event.target.value)} inputMode="numeric" /><textarea aria-label={t("files.inspector.note")} value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder={t("files.inspector.notePlaceholder")} rows={2} /><button disabled={!noteText.trim()}>{t("common.add")}</button></div></form>{notes.map((note) => <div className={styles.note} key={note.id}><button onClick={() => onGotoLine(note.line)}>L{note.line}</button><span>{note.text}</span><button aria-label={t("files.inspector.deleteNote")} onClick={() => saveNotes(notes.filter((item) => item.id !== note.id))}>×</button></div>)}</div>}
      </div>
    </div>
  );
}
