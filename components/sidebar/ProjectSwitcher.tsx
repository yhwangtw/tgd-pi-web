"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { shortenCwd } from "./session-utils";
import type { ProjectEntry } from "./CwdPicker";
import s from "./ProjectSwitcher.module.css";
import { useI18n } from "@/lib/i18n";

interface Worktree { path: string; branch: string | null; isMain: boolean }

/** One selectable row in the flattened, keyboard-navigable result list. */
interface Row {
  kind: "project" | "worktree" | "discovered" | "dir";
  path: string;
  name: string;
  /** parent project path for worktrees (drives indent) */
  parent?: string;
  count?: number;
  branch?: string | null;
  pinned?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (cwd: string) => void;
  /** Validate-and-pick for typed paths (returns an error message or null). */
  onPickPath: (path: string) => Promise<string | null>;
  onDefaultCwd: () => void;
  projects: ProjectEntry[];
  selectedCwd: string | null;
  homeDir: string;
}

const PINS_KEY = "pi-cwd-pins";
const HIDDEN_KEY = "pi-cwd-hidden";

function loadList(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveList(key: string, list: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* session-only */ }
}

const lastSegment = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const isPathQuery = (q: string) => q.startsWith("/") || q.startsWith("~");

/** Highlight the query match inside a name. */
function Name({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <b className={s.hl}>{text.slice(i, i + q.length)}</b>
      {text.slice(i + q.length)}
    </>
  );
}

/**
 * ⌘K-style project switcher: one input searches pinned + recent projects,
 * git worktrees, and repos discovered under ~; typing a `/` or `~` prefix
 * switches the same input into path mode with live directory completion.
 */
export function ProjectSwitcher({ open, onClose, onPick, onPickPath, onDefaultCwd, projects, selectedCwd, homeDir }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const [pins, setPins] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [discovered, setDiscovered] = useState<{ path: string; name: string }[]>([]);
  const [worktrees, setWorktrees] = useState<Map<string, Worktree[]>>(new Map());
  const [dirs, setDirs] = useState<{ base: string; names: string[] } | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const pathMode = isPathQuery(query);

  // ── Data loading on open ──────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIdx(0);
    setPathError(null);
    setPins(loadList(PINS_KEY));
    setHidden(loadList(HIDDEN_KEY));
    requestAnimationFrame(() => inputRef.current?.focus());

    let cancelled = false;
    fetch("/api/projects/discover")
      .then((r) => (r.ok ? r.json() : { repos: [] }))
      .then((d: { repos?: { path: string; name: string }[] }) => { if (!cancelled) setDiscovered(d.repos ?? []); })
      .catch(() => {});

    // Worktrees for the projects most likely on screen (bounded git calls).
    const targets = projects.slice(0, 8).map((p) => p.cwd);
    Promise.all(targets.map(async (cwd): Promise<[string, Worktree[]]> => {
      try {
        const r = await fetch(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`);
        if (!r.ok) return [cwd, []];
        const d = await r.json() as { worktrees?: Worktree[] };
        return [cwd, d.worktrees ?? []];
      } catch { return [cwd, []]; }
    })).then((pairs) => {
      if (cancelled) return;
      setWorktrees(new Map(pairs.filter(([, w]) => w.length > 1)));
    });
    return () => { cancelled = true; };
  }, [open, projects]);

  // ── Path-mode directory completion ───────────────────────────────────────
  useEffect(() => {
    if (!open || !pathMode) { setDirs(null); return; }
    const value = query;
    const timer = setTimeout(async () => {
      const slash = value.lastIndexOf("/");
      const parent = slash <= 0 ? (value.startsWith("~") ? "~" : "/") : value.slice(0, slash);
      try {
        const res = await fetch("/api/cwd/browse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: parent }),
        });
        if (!res.ok) { setDirs(null); return; }
        const data = await res.json() as { path: string; dirs: string[] };
        setDirs({ base: data.path, names: data.dirs });
      } catch {
        setDirs(null);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [query, pathMode, open]);

  // ── Result rows (flat, grouped by kind for labels) ───────────────────────
  const { rows, groups } = useMemo(() => {
    if (pathMode) {
      const slash = query.lastIndexOf("/");
      const prefix = query.slice(slash + 1).toLowerCase();
      const base = dirs?.base ?? "";
      const names = (dirs?.names ?? []).filter((n) => !prefix || n.toLowerCase().startsWith(prefix)).slice(0, 12);
      const rows: Row[] = names.map((n) => ({
        kind: "dir",
        name: n,
        path: base === "/" ? `/${n}` : `${base}/${n}`,
      }));
      return { rows, groups: rows.length ? [{ label: base ? shortenCwd(base, homeDir) + "/" : "…", start: 0 }] : [] };
    }

    const q = query.trim().toLowerCase();
    const hiddenSet = new Set(hidden);
    const match = (name: string, path: string) => !q || name.toLowerCase().includes(q) || path.toLowerCase().includes(q);

    const pinSet = new Set(pins);
    const knownCwds = new Set(projects.map((p) => p.cwd));
    // Only LINKED checkouts get folded into their parent row — the main
    // checkout is the project itself (it's also the list's first entry).
    const wtPaths = new Set([...worktrees.values()].flat().filter((w) => !w.isMain).map((w) => w.path));

    const projectRow = (p: ProjectEntry): Row[] => {
      const out: Row[] = [{ kind: "project", path: p.cwd, name: lastSegment(p.cwd), count: p.count, pinned: pinSet.has(p.cwd) }];
      for (const w of worktrees.get(p.cwd) ?? []) {
        if (w.isMain || w.path === p.cwd) continue;
        if (match(lastSegment(w.path), w.path) || match(out[0].name, p.cwd)) {
          out.push({ kind: "worktree", path: w.path, name: lastSegment(w.path), parent: p.cwd, branch: w.branch });
        }
      }
      return out;
    };

    const visible = projects.filter((p) => !hiddenSet.has(p.cwd) && !wtPaths.has(p.cwd) && match(lastSegment(p.cwd), p.cwd));
    const pinned = visible.filter((p) => pinSet.has(p.cwd));
    const recent = visible.filter((p) => !pinSet.has(p.cwd));
    const disc = discovered.filter((r) => !knownCwds.has(r.path) && !hiddenSet.has(r.path) && !wtPaths.has(r.path) && match(r.name, r.path)).slice(0, 10);

    const rows: Row[] = [];
    const groups: { label: string; start: number }[] = [];
    if (pinned.length) {
      groups.push({ label: `★ ${t("cwd.pinnedGroup")}`, start: rows.length });
      pinned.forEach((p) => rows.push(...projectRow(p)));
    }
    if (recent.length) {
      groups.push({ label: t("cwd.recentGroup"), start: rows.length });
      recent.forEach((p) => rows.push(...projectRow(p)));
    }
    if (disc.length) {
      groups.push({ label: t("cwd.discoveredGroup"), start: rows.length });
      disc.forEach((r) => rows.push({ kind: "discovered", path: r.path, name: r.name }));
    }
    return { rows, groups };
  }, [pathMode, query, dirs, projects, pins, hidden, discovered, worktrees, homeDir, t]);

  useEffect(() => setIdx(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const pick = useCallback((row: Row) => {
    if (row.kind === "dir") {
      // Drill into the directory; Enter on the typed path itself commits.
      setQuery(row.path + "/");
      inputRef.current?.focus();
      return;
    }
    onPick(row.path);
    onClose();
  }, [onPick, onClose]);

  const commitTypedPath = useCallback(async () => {
    const err = await onPickPath(query.trim().replace(/\/$/, "") || "/");
    if (err) setPathError(err);
    else onClose();
  }, [query, onPickPath, onClose]);

  const togglePin = useCallback((path: string) => {
    setPins((prev) => {
      const next = prev.includes(path) ? prev.filter((c) => c !== path) : [...prev, path];
      saveList(PINS_KEY, next);
      return next;
    });
  }, []);

  const hideProject = useCallback((path: string) => {
    setHidden((prev) => {
      const next = prev.includes(path) ? prev : [...prev, path];
      saveList(HIDDEN_KEY, next);
      return next;
    });
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => rows.length ? (i + 1) % rows.length : 0); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => rows.length ? (i - 1 + rows.length) % rows.length : 0); return; }
    if (e.key === "Tab" && pathMode && rows[idx]) {
      e.preventDefault();
      setQuery(rows[idx].path + "/");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (pathMode) {
        // Enter picks the highlighted dir if it exactly continues the query,
        // otherwise commits the typed path as-is.
        void commitTypedPath();
      } else if (rows[idx]) {
        pick(rows[idx]);
      }
    }
  }, [rows, idx, pathMode, pick, commitTypedPath, onClose]);

  if (!open || typeof document === "undefined") return null;

  let rowCursor = -1;
  return createPortal(
    <div className={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s.modal} role="dialog" aria-label={t("cwd.switcherTitle")} data-testid="project-switcher">
        <div className={s.inputRow}>
          {pathMode ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPathError(null); }}
            onKeyDown={onKeyDown}
            placeholder={t("cwd.switcherPlaceholder")}
            className={pathMode ? s.inputMono : s.input}
            spellCheck={false}
          />
        </div>

        <div className={s.body} ref={listRef}>
          {pathError && <div className={s.error}>{pathError}</div>}
          {rows.length === 0 && !pathError && (
            <div className={s.emptyNote}>{pathMode ? t("cwd.noSubdirs") : t("cwd.noMatches")}</div>
          )}
          {groups.map((g, gi) => {
            const end = gi + 1 < groups.length ? groups[gi + 1].start : rows.length;
            return (
              <div key={g.label + g.start}>
                <div className={s.groupLabel}>{g.label}</div>
                {rows.slice(g.start, end).map((row) => {
                  rowCursor++;
                  const i = rowCursor;
                  const active = i === idx;
                  return (
                    <div
                      key={row.path}
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setIdx(i)}
                      onClick={() => pick(row)}
                      className={`${s.row} ${active ? s.rowActive : ""} ${row.kind === "worktree" ? s.rowNested : ""}`}
                      title={row.path}
                      data-testid={row.kind === "worktree"
                        ? "worktree-row"
                        : row.kind === "dir"
                          ? "path-completion-option"
                          : undefined}
                    >
                      <span className={s.rowIcon}>
                        {row.kind === "worktree" || row.kind === "discovered" ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
                        ) : (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                        )}
                      </span>
                      <span className={s.rowName}>
                        {row.pinned && <span className={s.pinDot} aria-hidden>★ </span>}
                        <Name text={row.name} q={pathMode ? "" : query.trim()} />
                      </span>
                      <span className={s.rowPath}>{row.kind === "dir" ? "" : shortenCwd(row.path, homeDir)}</span>
                      {row.branch && <span className={s.branchChip}>{row.branch}</span>}
                      {row.kind === "project" && row.count !== undefined && (
                        <span className={s.countChip}>{row.count} session{row.count === 1 ? "" : "s"}</span>
                      )}
                      {row.kind === "discovered" && <span className={s.gitChip}>git</span>}
                      {row.kind === "project" && (
                        <span className={s.rowActions}>
                          <button
                            onClick={(e) => { e.stopPropagation(); togglePin(row.path); }}
                            className={s.rowActionBtn}
                            title={row.pinned ? t("cwd.unpin") : t("cwd.pin")}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill={row.pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                          </button>
                          {row.path !== selectedCwd && (
                            <button
                              onClick={(e) => { e.stopPropagation(); hideProject(row.path); }}
                              className={s.rowActionBtn}
                              title={t("cwd.hide")}
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className={s.footer}>
          {pathMode ? (
            <>
              <span><kbd>Tab</kbd> {t("cwd.footComplete")}</span>
              <span><kbd>↵</kbd> {t("cwd.useThis")}</span>
              <span><kbd>esc</kbd> {t("cwd.footClose")}</span>
            </>
          ) : (
            <>
              <span><kbd>↑↓</kbd> {t("cwd.footNav")}</span>
              <span><kbd>↵</kbd> {t("cwd.footOpen")}</span>
              <span><kbd>esc</kbd> {t("cwd.footClose")}</span>
              <span className={s.footHint}>{t("cwd.footPathHint")}</span>
            </>
          )}
          <button className={s.defaultBtn} onClick={() => { onDefaultCwd(); onClose(); }}>
            {t("cwd.default")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
