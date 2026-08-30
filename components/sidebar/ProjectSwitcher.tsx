"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Folder, GitBranch, Search, Star, X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { shortenCwd } from "./session-utils";
import type { ProjectEntry } from "./CwdPicker";
import s from "./ProjectSwitcher.module.css";
import { useI18n } from "@/lib/i18n";
import { fetchJson, useRequestResource } from "@/hooks/useRequestResource";

interface Worktree { path: string; branch: string | null; isMain: boolean }
interface ProjectDiscoveryResponse { repos?: { path: string; name: string }[] }
interface ProjectSwitcherData {
  discovered: { path: string; name: string }[];
  worktrees: [string, Worktree[]][];
}
interface BrowseResponse { path: string; dirs: string[] }

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
const EMPTY_DISCOVERED: { path: string; name: string }[] = [];

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
  const [pathError, setPathError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const pathMode = isPathQuery(query);
  const projectTargets = useMemo(() => projects.slice(0, 8).map((project) => project.cwd), [projects]);
  const projectTargetsKey = projectTargets.join("\u0000");
  const projectResource = useRequestResource<ProjectSwitcherData>(
    open ? `project-switcher:${projectTargetsKey}` : null,
    async (signal) => {
      const discovery = await fetchJson<ProjectDiscoveryResponse>("/api/projects/discover", {}, signal);
      const worktrees = await Promise.all(projectTargets.map(async (cwd): Promise<[string, Worktree[]]> => {
        try {
          const response = await fetchJson<{ worktrees?: Worktree[] }>(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`, {}, signal);
          return [cwd, response.worktrees ?? []];
        } catch (error) {
          if (signal.aborted) throw error;
          return [cwd, []];
        }
      }));
      return { discovered: discovery.repos ?? [], worktrees };
    },
    { staleTimeMs: 60_000, retries: 1 },
  );
  const discovered = projectResource.data?.discovered ?? EMPTY_DISCOVERED;
  const worktrees = useMemo(() => new Map(
    (projectResource.data?.worktrees ?? []).filter(([, items]) => items.length > 1),
  ), [projectResource.data]);
  const browseParent = useMemo(() => {
    if (!pathMode) return null;
    const slash = query.lastIndexOf("/");
    return slash <= 0 ? (query.startsWith("~") ? "~" : "/") : query.slice(0, slash);
  }, [pathMode, query]);
  const browseResource = useRequestResource<BrowseResponse>(
    open && browseParent ? `project-browse:${browseParent}` : null,
    (signal) => fetchJson<BrowseResponse>("/api/cwd/browse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: browseParent }),
    }, signal),
    { debounceMs: 150, staleTimeMs: 15_000, retries: 1 },
  );
  const dirs = useMemo(() => browseResource.data
    ? { base: browseResource.data.path, names: browseResource.data.dirs }
    : null, [browseResource.data]);

  // ── Data loading on open ──────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIdx(0);
    setPathError(null);
    setPins(loadList(PINS_KEY));
    setHidden(loadList(HIDDEN_KEY));
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

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

  const resourceLoading = pathMode
    ? browseResource.loading || browseResource.refreshing
    : projectResource.loading || projectResource.refreshing;
  const resourceError = pathMode ? browseResource.error : projectResource.error;
  const retryResource = () => void (pathMode ? browseResource.refresh() : projectResource.refresh());
  let rowCursor = -1;
  return createPortal(
    <div className={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s.modal} role="dialog" aria-modal="true" aria-label={t("cwd.switcherTitle")} data-testid="project-switcher">
        <div className={s.inputRow}>
          {pathMode ? (
            <Folder size={16} strokeWidth={1.8} color="var(--color-accent)" aria-hidden="true" />
          ) : (
            <Search size={16} strokeWidth={1.8} color="var(--text-dim)" aria-hidden="true" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPathError(null); }}
            onKeyDown={onKeyDown}
            placeholder={t("cwd.switcherPlaceholder")}
            aria-label={t("cwd.switcherTitle")}
            className={pathMode ? s.inputMono : s.input}
            spellCheck={false}
          />
        </div>

        <div className={s.body} ref={listRef} role="listbox" aria-label={t("cwd.switcherTitle")}>
          {pathError && <div className={s.error}>{pathError}</div>}
          {rows.length === 0 && !pathError && (
            <div className={s.emptyNote} data-error={Boolean(resourceError)}>
              {resourceLoading
                ? t("cwd.loadingProjects")
                : resourceError
                  ? <><span>{t("cwd.loadFailed")}</span><button type="button" onClick={retryResource}>{t("common.retry")}</button></>
                  : pathMode ? t("cwd.noSubdirs") : t("cwd.noMatches")}
            </div>
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
                          <GitBranch size={14} strokeWidth={1.8} aria-hidden="true" />
                        ) : (
                          <Folder size={15} strokeWidth={1.8} aria-hidden="true" />
                        )}
                      </span>
                      <span className={s.rowName}>
                        {row.pinned && <Star className={s.pinDot} size={12} strokeWidth={1.8} fill="currentColor" aria-hidden="true" />}
                        <Name text={row.name} q={pathMode ? "" : query.trim()} />
                      </span>
                      <span className={s.rowPath}>{row.kind === "dir" ? "" : shortenCwd(row.path, homeDir)}</span>
                      {row.branch && <span className={s.branchChip}>{row.branch}</span>}
                      {row.kind === "project" && row.count !== undefined && (
                        <span className={s.countChip}>{t("cwd.sessionCount").replace("{count}", row.count.toLocaleString())}</span>
                      )}
                      {row.kind === "discovered" && <span className={s.gitChip}>git</span>}
                      {row.kind === "project" && (
                        <span className={s.rowActions}>
                          <IconButton
                            label={row.pinned ? t("cwd.unpin") : t("cwd.pin")}
                            icon={<Star strokeWidth={1.8} fill={row.pinned ? "currentColor" : "none"} />}
                            size="compact"
                            onClick={(e) => { e.stopPropagation(); togglePin(row.path); }}
                            className={s.rowActionBtn}
                          />
                          {row.path !== selectedCwd && (
                            <IconButton
                              label={t("cwd.hide")}
                              icon={<X strokeWidth={2} />}
                              size="compact"
                              onClick={(e) => { e.stopPropagation(); hideProject(row.path); }}
                              className={s.rowActionBtn}
                            />
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
              <span><kbd>{t("cwd.keyTab")}</kbd> {t("cwd.footComplete")}</span>
              <span><kbd>↵</kbd> {t("cwd.useThis")}</span>
              <span><kbd>{t("cwd.keyEscape")}</kbd> {t("cwd.footClose")}</span>
            </>
          ) : (
            <>
              <span><kbd>↑↓</kbd> {t("cwd.footNav")}</span>
              <span><kbd>↵</kbd> {t("cwd.footOpen")}</span>
              <span><kbd>{t("cwd.keyEscape")}</kbd> {t("cwd.footClose")}</span>
              <span className={s.footHint}>{t("cwd.footPathHint")}</span>
            </>
          )}
          <button type="button" className={s.defaultBtn} onClick={() => { onDefaultCwd(); onClose(); }}>
            {t("cwd.default")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
