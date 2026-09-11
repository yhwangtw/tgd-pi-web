import type { SessionInfo } from "@/lib/types";

export function getSessionDisplayTitle(session: SessionInfo, maxLength = 80): string {
  const title = session.name?.trim() || session.firstMessage?.trim() || "Untitled session";
  if (title.length <= maxLength) return title;
  return `${title.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

/**
 * Sidebar-only titles that remain distinguishable when several conversations
 * share the same auto-generated title. Prefer the repo name; if that still
 * collides, append progressively more precise activity time and finally the
 * short session id. The final fallback matters for imported/test sessions
 * whose timestamps can be identical down to the minute.
 */
export function buildSessionDisplayTitles(sessions: SessionInfo[], maxLength = 64): Map<string, string> {
  const baseById = new Map(sessions.map((session) => [session.id, getSessionDisplayTitle(session, maxLength)]));
  const groups = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const key = (baseById.get(session.id) ?? "").toLocaleLowerCase();
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }

  const result = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      const session = group[0];
      result.set(session.id, baseById.get(session.id)!);
      continue;
    }

    const repoCounts = new Map<string, number>();
    const repoDateCounts = new Map<string, number>();
    const repoMinuteCounts = new Map<string, number>();
    for (const session of group) {
      const repo = getSessionProjectName(session.cwd);
      const date = session.modified.slice(0, 10);
      const minute = session.modified.slice(0, 16).replace("T", " ");
      repoCounts.set(repo, (repoCounts.get(repo) ?? 0) + 1);
      repoDateCounts.set(`${repo}\0${date}`, (repoDateCounts.get(`${repo}\0${date}`) ?? 0) + 1);
      repoMinuteCounts.set(`${repo}\0${minute}`, (repoMinuteCounts.get(`${repo}\0${minute}`) ?? 0) + 1);
    }
    for (const session of group) {
      const base = baseById.get(session.id)!;
      const repo = getSessionProjectName(session.cwd);
      const date = session.modified.slice(0, 10);
      const minute = session.modified.slice(0, 16).replace("T", " ");
      const suffix = repoCounts.get(repo) === 1
        ? repo
        : repoDateCounts.get(`${repo}\0${date}`) === 1
          ? `${repo} · ${date}`
          : repoMinuteCounts.get(`${repo}\0${minute}`) === 1
            ? `${repo} · ${minute}`
            : `${repo} · ${minute} · ${session.id.replace(/-/g, "").slice(-6)}`;
      const available = Math.max(1, maxLength - suffix.length - 3);
      const compactBase = base.length > available ? `${base.slice(0, Math.max(1, available - 1)).trimEnd()}…` : base;
      result.set(session.id, `${compactBase} · ${suffix}`);
    }
  }
  return result;
}

/** Last-message preview, excluding a duplicate of the opening message. */
export function getSessionPreview(session: SessionInfo): string {
  const preview = sessionPreviewText(session.lastMessage ?? "");
  if (!preview) return "";
  return preview === sessionPreviewText(session.firstMessage ?? "") ? "" : preview;
}

/** Bounded, display-only Markdown excerpt; never interpreted as HTML. */
export function sessionPreviewText(text: string): string {
  const plain = text.slice(0, 8_000)
    .replace(/^[ \t]*(?:>[ \t]*)+/gm, "")
    .replace(/^\[![A-Z_-]+\][ \t]*/gm, "")
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[ \t][^>\n]*)?\/?>/g, "")
    .replace(/`+([^`\n]+)`+/g, "$1")
    .replace(/(\*\*|__|~~)([^\n]+?)\1/g, "$2")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?，。！？]|$)/g, "$1$2")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gm, "")
    .replace(/\s+/g, " ").trim();
  return plain.length > 240 ? `${Array.from(plain).slice(0, 239).join("")}…` : plain;
}

export function formatRelativeTime(dateStr: string, locale: "en" | "zh" = "en"): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return locale === "zh" ? "剛剛" : "just now";
  if (mins < 60) return locale === "zh" ? `${mins} 分鐘前` : `${mins}m ago`;
  if (hours < 24) return locale === "zh" ? `${hours} 小時前` : `${hours}h ago`;
  if (days < 7) return locale === "zh" ? `${days} 天前` : `${days}d ago`;
  return date.toLocaleDateString(locale === "zh" ? "zh-TW" : undefined);
}

/** Return the 5 most recently active cwds across all sessions */
export function getRecentCwds(sessions: SessionInfo[]): string[] {
  const latestByCwd = new Map<string, string>(); // cwd -> most recent modified
  for (const s of sessions) {
    if (!s.cwd) continue;
    const prev = latestByCwd.get(s.cwd);
    if (!prev || s.modified > prev) {
      latestByCwd.set(s.cwd, s.modified);
    }
  }
  return [...latestByCwd.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, 5)
    .map(([cwd]) => cwd);
}

export function shortenCwd(cwd: string, homeDir?: string): string {
  const path = (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
  const sep = path.includes("/") ? "/" : "\\";
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= 2) return path;
  return "…/" + parts.slice(-2).join(sep);
}

/** Human-readable project identity for a session row in the cross-project list. */
export function getSessionProjectName(cwd: string): string {
  if (!cwd) return "Unknown project";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

export function getSessionDateGroup(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  if (date >= startOfToday) return "Today";
  if (date >= startOfYesterday) return "Yesterday";
  if (date >= startOfWeek) return "This Week";
  return "Earlier";
}

export interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

export interface FlatSessionTreeNode {
  node: SessionTreeNode;
  depth: number;
}

export type SessionSortMode = "recent" | "name" | "messages";

const SORT_COMPARATORS: Record<SessionSortMode, (a: SessionTreeNode, b: SessionTreeNode) => number> = {
  recent: (a, b) => b.session.modified.localeCompare(a.session.modified),
  name: (a, b) => (a.session.name || a.session.firstMessage || a.session.id)
    .localeCompare(b.session.name || b.session.firstMessage || b.session.id, undefined, { sensitivity: "base" }),
  messages: (a, b) => (b.session.messageCount - a.session.messageCount)
    || b.session.modified.localeCompare(a.session.modified),
};

export function buildSessionTree(sessions: SessionInfo[], sortMode: SessionSortMode = "recent"): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Roots follow the caller's sort mode; fork children always stay in
  // recency order (they read as a chronological thread under the parent).
  roots.sort(SORT_COMPARATORS[sortMode]);
  const sortChildren = (nodes: SessionTreeNode[]) => {
    nodes.sort(SORT_COMPARATORS.recent);
    nodes.forEach((n) => sortChildren(n.children));
  };
  roots.forEach((n) => sortChildren(n.children));
  return roots;
}

/** Find any node, including a fork nested below a root session. */
export function findSessionTreeNode(nodes: SessionTreeNode[], id: string): SessionTreeNode | null {
  for (const node of nodes) {
    if (node.session.id === id) return node;
    const child = findSessionTreeNode(node.children, id);
    if (child) return child;
  }
  return null;
}

/**
 * Flatten the visible portion of a fork tree for windowed rendering.
 * Excluded nodes (for example pinned conversations) are removed without
 * hiding their non-excluded descendants, which keeps the pinned section
 * independent from the chronological list.
 */
export function flattenSessionTree(
  nodes: SessionTreeNode[],
  collapsedIds: ReadonlySet<string> = new Set(),
  excludedIds: ReadonlySet<string> = new Set(),
): FlatSessionTreeNode[] {
  const rows: FlatSessionTreeNode[] = [];
  const visit = (node: SessionTreeNode, depth: number) => {
    const excluded = excludedIds.has(node.session.id);
    if (!excluded) rows.push({ node, depth });
    if (collapsedIds.has(node.session.id)) return;
    const childDepth = excluded ? depth : depth + 1;
    for (const child of node.children) visit(child, childDepth);
  };
  for (const node of nodes) visit(node, 0);
  return rows;
}
