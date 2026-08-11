"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { encodeFilePathForApi, getRelativeFilePath, joinFilePath } from "@/lib/file-paths";
import styles from "./FileExplorer.module.css";
import { useI18n } from "@/lib/i18n";
import { saveTreeExpansion, loadTreeExpansion } from "@/lib/tree-expansion-memory";
import { showToast } from "@/hooks/useToast";
import { createFile, createDir, renameEntry, deleteEntry, uploadFiles } from "@/lib/file-ops-client";
import { FileOpsDialog, type FileOpRequest } from "./FileOpsDialog";

const JUNK_DIRS = new Set([
  ".git", ".next", ".nuxt", "node_modules", "__pycache__", ".venv", "venv",
  ".idea", ".vscode", ".DS_Store", "dist", "build", ".cache", ".turbo",
]);

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface MenuTarget {
  x: number;
  y: number;
  fullPath: string;
  relative: string;
  isDir: boolean;
  gitStatus?: string;
  /** Right-clicked empty space → only creation/upload actions. */
  rootArea?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string) => void;
  /** Open the HEAD ↔ worktree diff for a changed file (relative path). */
  onOpenDiff?: (relativePath: string) => void;
  /** Absolute path of the file currently shown in the viewer (for highlight). */
  activeFilePath?: string | null;
  /** Bump to reveal `activeFilePath` in the tree (expand ancestors). */
  revealSignal?: number;
}

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) return [];
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? [])
    .filter((e) => !JUNK_DIRS.has(e.name))
    .map((e) => ({
      name: e.name,
      fullPath: joinFilePath(dirPath, e.name),
      isDir: e.isDir,
      size: e.size,
      children: e.isDir ? [] : undefined,
      loaded: !e.isDir,
    }));
}

/** Porcelain status → badge letter + color. */
function GitBadge({ status }: { status: string }) {
  const letter = status === "??" ? "U" : status[0];
  const color =
    letter === "D" ? "var(--color-error-text)"
    : letter === "A" || letter === "U" ? "var(--color-success)"
    : "var(--color-warning-text-strong)";
  return <span className={styles.gitBadge} style={{ color }}>{letter}</span>;
}

function TreeNode({
  node, depth, cwd, onOpenFile, onAtMention, expandedPaths, onToggleExpanded,
  refreshKey, gitStatus, onContextMenu, activePath,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshKey?: number;
  gitStatus: Map<string, string>;
  onContextMenu: (t: MenuTarget) => void;
  activePath?: string | null;
}) {
  const { t } = useI18n();
  const open = expandedPaths.has(node.fullPath);
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  // Re-fetch children when refreshKey changes and the directory is already open/loaded
  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Load children whenever the node is open but not yet loaded. Clicks flow
  // through here too, and it also covers dirs that *start* open — restored
  // per-cwd expansions and reveal-from-search — which never get a click.
  useEffect(() => {
    if (open && !loaded && !loading) loadChildren();
  }, [open, loaded, loading, loadChildren]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      onToggleExpanded(node.fullPath, !open);
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, open, onOpenFile, onToggleExpanded]);

  const relative = getRelativeFilePath(node.fullPath, cwd);
  const fileStatus = node.isDir ? undefined : gitStatus.get(relative);
  // A dir is "dirty" when any changed file lives under it.
  let dirDirty = false;
  if (node.isDir && gitStatus.size > 0) {
    const prefix = `${relative}/`;
    for (const key of gitStatus.keys()) {
      if (key.startsWith(prefix)) { dirDirty = true; break; }
    }
  }

  return (
    <div>
      <div
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu({ x: e.clientX, y: e.clientY, fullPath: node.fullPath, relative, isDir: node.isDir, gitStatus: fileStatus });
        }}
        onMouseDown={(e) => (e.currentTarget as HTMLElement).focus()}
        className={`hover-bg hover-group ${styles.treeNode} ${!node.isDir && activePath === node.fullPath ? styles.treeNodeActive : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        tabIndex={-1}
        role="treeitem"
        aria-label={node.name}
        aria-level={depth + 1}
        aria-expanded={node.isDir ? open : undefined}
        aria-selected={activePath === node.fullPath}
        data-fx-row
        data-dir={node.isDir ? "1" : "0"}
        data-open={open ? "1" : "0"}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            className={styles.treeChevron}
            style={{ transform: open ? "rotate(90deg)" : "none" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span className={styles.fileSpacer} />}
        <span className={styles.iconWrapper}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span className={styles.fileName} title={node.fullPath}>
          {node.name}
        </span>
        {fileStatus && <GitBadge status={fileStatus} />}
        {dirDirty && <span className={styles.dirtyDot} aria-hidden />}
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {onAtMention && !node.isDir && (
          <button
            type="button"
            className={`hover-reveal ${styles.mentionButton}`}
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(relative);
            }}
            aria-label={`${t("explorer.mention")}: ${node.name}`}
            title={t("explorer.mention")}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
            </svg>
            mention
          </button>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode key={child.fullPath} node={child} depth={depth + 1} cwd={cwd} onOpenFile={onOpenFile} onAtMention={onAtMention} expandedPaths={expandedPaths} onToggleExpanded={onToggleExpanded} refreshKey={refreshKey} gitStatus={gitStatus} onContextMenu={onContextMenu} activePath={activePath} />
          ))}
          {children.length === 0 && loaded && (
            <div className={styles.emptyDirMessage} style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ cwd, onOpenFile, refreshKey, onAtMention, onOpenDiff, activeFilePath, revealSignal }: Props) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const prevCwdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const bumpRefresh = useCallback(() => setLocalRefresh((n) => n + 1), []);
  const [dialog, setDialog] = useState<FileOpRequest | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string>(cwd);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  // Remember the expansion per cwd so switching projects and back keeps the
  // tree open where it was (in-memory; a fresh page load starts collapsed).
  // expansionCwdRef names the cwd the current state belongs to — it gates the
  // save so a mount/switch (state still empty or from the old cwd) can't
  // clobber the remembered set before the restore below has run.
  const expansionCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (expansionCwdRef.current === cwd) saveTreeExpansion(cwd, expandedPaths);
  }, [cwd, expandedPaths]);

  // Combined refresh: parent bumps (refreshKey) + local file-op bumps.
  const treeRefresh = (refreshKey ?? 0) + localRefresh;

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // On cwd change, restore that cwd's remembered expansion (empty for a
    // never-visited cwd). refreshKey bumps leave the expansion alone.
    if (cwdChanged) {
      setExpandedPaths(loadTreeExpansion(cwd));
      expansionCwdRef.current = cwd;
    }

    setLoading(cwdChanged);
    setError(null);
    fetchEntries(cwd)
      .then((entries) => setRoots(entries))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cwd, treeRefresh]);

  // ── Git working-tree status (badges) ────────────────────────────────────
  const [gitStatus, setGitStatus] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    fetch(`/api/git/changes?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { git?: boolean; files?: { path: string; status: string }[] }) => {
        if (!alive) return;
        const map = new Map<string, string>();
        if (d?.git && Array.isArray(d.files)) {
          for (const f of d.files) map.set(f.path, f.status);
        }
        setGitStatus(map);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [cwd, treeRefresh]);

  /** Expand every ancestor needed to reveal a path in the tree. */
  const revealInTree = useCallback((relative: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      const parts = relative.split("/");
      let acc = cwd;
      for (const part of parts) {
        acc = joinFilePath(acc, part);
        next.add(acc);
      }
      return next;
    });
  }, [cwd]);

  // ── Reveal the active file when asked (tab "reveal in explorer") ──
  useEffect(() => {
    if (!revealSignal || !activeFilePath) return;
    const rel = getRelativeFilePath(activeFilePath, cwd);
    if (rel.startsWith("..") || rel.startsWith("/")) return; // outside this cwd
    revealInTree(rel);
    setTimeout(() => {
      const row = containerRef.current?.querySelector<HTMLElement>(`[title="${CSS.escape(activeFilePath)}"]`);
      row?.scrollIntoView({ block: "center" });
    }, 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSignal]);

  // ── File operations (create / rename / delete / upload) ──
  const doUpload = useCallback(async (dir: string, files: File[]) => {
    if (files.length === 0) return;
    const { results, error } = await uploadFiles(dir, files);
    if (error) { showToast(`${t("explorer.uploadFailed")}: ${error}`, { type: "error" }); return; }
    const okCount = results.filter((r) => r.ok).length;
    for (const f of results.filter((r) => !r.ok)) {
      showToast(`${t("explorer.uploadFailed")}: ${f.name} — ${f.error}`, { type: "error" });
    }
    if (okCount > 0) showToast(`${t("explorer.uploaded")}: ${okCount}`);
    revealInTree(getRelativeFilePath(dir, cwd));
    bumpRefresh();
  }, [cwd, t, revealInTree, bumpRefresh]);

  const runOp = useCallback(async (name: string): Promise<string | null> => {
    if (!dialog) return null;
    let res: { error?: string };
    if (dialog.kind === "new-file") res = await createFile(dialog.targetPath, name);
    else if (dialog.kind === "new-folder") res = await createDir(dialog.targetPath, name);
    else if (dialog.kind === "rename") res = await renameEntry(dialog.targetPath, name);
    else res = await deleteEntry(dialog.targetPath);
    if (res.error) return res.error;
    bumpRefresh();
    return null;
  }, [dialog, bumpRefresh]);

  const onFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    void doUpload(uploadTargetRef.current, Array.from(e.target.files ?? []));
    e.target.value = "";
  }, [doUpload]);

  const openUpload = useCallback((dir: string) => {
    uploadTargetRef.current = dir;
    uploadInputRef.current?.click();
  }, []);

  // ── Context menu ─────────────────────────────────────────────────────────
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const copyText = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setMenu(null);
  }, []);

  // ── Keyboard navigation over rendered rows ───────────────────────────────
  const onTreeKeyDown = useCallback((e: React.KeyboardEvent) => {
    const rows = Array.from(containerRef.current?.querySelectorAll<HTMLElement>("[data-fx-row]") ?? []);
    if (rows.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? rows.indexOf(active) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = idx === -1 ? 0 : e.key === "ArrowDown" ? Math.min(idx + 1, rows.length - 1) : Math.max(idx - 1, 0);
      rows[next]?.focus();
    } else if (e.key === "Enter" && idx >= 0) {
      e.preventDefault();
      rows[idx].click();
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && idx >= 0) {
      const el = rows[idx];
      const isDir = el.dataset.dir === "1";
      const open = el.dataset.open === "1";
      if (isDir && ((e.key === "ArrowRight" && !open) || (e.key === "ArrowLeft" && open))) {
        e.preventDefault();
        el.click();
      }
    }
  }, []);

  if (loading) {
    return (
      <div className={styles.loadingWrapper}>
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={`skeleton-line ${styles.skeletonLine}`} style={{ width: `${60 + (i % 3) * 15}%`, marginLeft: i * 4 }} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.errorMessage}>
        {error}
      </div>
    );
  }

  return (
    <div
      className={dragOver ? styles.dragActive : undefined}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(false);
        void doUpload(cwd, Array.from(e.dataTransfer.files));
      }}
    >
      <input ref={uploadInputRef} type="file" multiple hidden onChange={onFileInputChange} />
      {dragOver && <div className={styles.dropHint}>{t("explorer.dropToUpload")}</div>}

      <div ref={containerRef} className={styles.treeContainer} onKeyDown={onTreeKeyDown}
        role="tree"
        aria-label={t("sidebar.explorer")}
        tabIndex={0}
        onContextMenu={(e) => {
          // Right-click on empty space → root-level ops.
          if ((e.target as HTMLElement).closest("[data-fx-row]")) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, fullPath: cwd, relative: "", isDir: true, rootArea: true });
        }}
      >
        {roots.map((node) => (
          <TreeNode
            key={node.fullPath}
            node={node}
            depth={0}
            cwd={cwd}
            onOpenFile={onOpenFile}
            onAtMention={onAtMention}
            expandedPaths={expandedPaths}
            onToggleExpanded={handleToggleExpanded}
            refreshKey={treeRefresh}
            gitStatus={gitStatus}
            onContextMenu={setMenu}
            activePath={activeFilePath}
          />
        ))}
        {roots.length === 0 && (
          <div className={styles.noResults}>No files found</div>
        )}
      </div>

      {/* Context menu */}
      {menu && (() => {
        // New file/folder target: the dir itself, or the file's parent dir.
        const parentDir = menu.isDir ? menu.fullPath : menu.fullPath.slice(0, menu.fullPath.lastIndexOf("/")) || cwd;
        return (
        <div
          className={`glass ${styles.contextMenu}`}
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
        >
          <button className={styles.menuItem} onClick={() => { setDialog({ kind: "new-file", targetPath: parentDir, label: getRelativeFilePath(parentDir, cwd) || "/" }); setMenu(null); }}>
            {t("explorer.newFile")}
          </button>
          <button className={styles.menuItem} onClick={() => { setDialog({ kind: "new-folder", targetPath: parentDir, label: getRelativeFilePath(parentDir, cwd) || "/" }); setMenu(null); }}>
            {t("explorer.newFolder")}
          </button>
          <button className={styles.menuItem} onClick={() => { openUpload(parentDir); setMenu(null); }}>
            {t("explorer.uploadHere")}
          </button>
          {!menu.rootArea && <div className={styles.menuSep} />}
          {!menu.rootArea && (
            <button className={styles.menuItem} onClick={() => { setDialog({ kind: "rename", targetPath: menu.fullPath, label: menu.relative, currentName: menu.fullPath.split("/").pop(), isDir: menu.isDir }); setMenu(null); }}>
              {t("explorer.rename")}
            </button>
          )}
          {!menu.rootArea && (
            <button className={`${styles.menuItem} ${styles.menuItemDanger}`} onClick={() => { setDialog({ kind: "delete", targetPath: menu.fullPath, label: menu.relative, isDir: menu.isDir }); setMenu(null); }}>
              {t("explorer.delete")}
            </button>
          )}
          {!menu.rootArea && <div className={styles.menuSep} />}
          {!menu.rootArea && (
            <button className={styles.menuItem} onClick={() => copyText(menu.fullPath)}>
              {t("explorer.copyPath")}
            </button>
          )}
          {!menu.rootArea && (
            <button className={styles.menuItem} onClick={() => copyText(menu.relative)}>
              {t("explorer.copyRel")}
            </button>
          )}
          {onAtMention && !menu.rootArea && (
            <button className={styles.menuItem} onClick={() => { onAtMention(menu.relative); setMenu(null); }}>
              {t("explorer.mention")}
            </button>
          )}
          {onOpenDiff && !menu.isDir && menu.gitStatus && (
            <button className={styles.menuItem} onClick={() => { onOpenDiff(menu.relative); setMenu(null); }}>
              {t("explorer.diff")}
            </button>
          )}
          {!menu.isDir && !menu.rootArea && (
            <a
              className={styles.menuItem}
              href={`/api/files/${encodeFilePathForApi(menu.fullPath)}?type=download`}
              download
              onClick={() => setMenu(null)}
            >
              {t("explorer.download")}
            </a>
          )}
        </div>
        );
      })()}

      {dialog && (
        <FileOpsDialog req={dialog} onClose={() => setDialog(null)} onSubmit={runOp} />
      )}
    </div>
  );
}
