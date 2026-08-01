import type { SessionInfo } from "@/lib/types";

export function getSessionDisplayTitle(session: SessionInfo, maxLength = 80): string {
  const title = session.name?.trim() || session.firstMessage?.trim() || "Untitled session";
  if (title.length <= maxLength) return title;
  return `${title.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
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
