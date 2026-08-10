"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import type { SessionInfo } from "@/lib/types";
import type { SessionTags } from "./useTags";
import type { Skin } from "@/lib/skin";
import type { UiStyle } from "@/lib/ui-style";

// ── Result types ───────────────────────────────────────────────────────────

export type PaletteResultKind = "session" | "tag" | "action";

export interface PaletteResult {
  id: string;
  kind: PaletteResultKind;
  title: string;
  subtitle: string;
  /** Optional search-haystack boost term; matched independently of title/subtitle. */
  keywords?: string;
  /** Right-aligned hotkey hint chip, e.g. "↵" or "⇧⌘P". */
  hint?: string;
  /** Free-form payload — discriminated by `kind`. */
  data: unknown;
}

export type PaletteActionId =
  | "settings:models"
  | "settings:skills"
  | "settings:extensions"
  | "settings:prompts"
  | "settings:analytics"
  | "settings:appearance"
  | "view:toggle-theme"
  | "view:toggle-sidebar"
  | "view:toggle-file-panel"
  | "view:toggle-chat-width"
  | "view:toggle-follow"
  | "ui-style:original"
  | "ui-style:trae"
  | "skin:trae"
  | "skin:terminal"
  | "skin:industrial"
  | "skin:aurora"
  | "skin:editorial"
  | "skin:glass"
  | "view:clear-tag"
  | "session:new"
  | "session:import"
  | "session:open-parallel"
  | "help:shortcuts";

export interface CommandPaletteApi {
  open: () => void;
  query: string;
  setQuery: (q: string) => void;
  results: PaletteResult[];
  runAction: (r: PaletteResult) => void;
  // Wiring the action registry is the consumer's job; we only store the
  // callbacks we need to fire and let the host provide them via register().
  register: (callbacks: PaletteCallbacks) => void;
}

export interface PaletteCallbacks {
  openModels: () => void;
  openSkills: () => void;
  openExtensions: () => void;
  openPrompts: () => void;
  openAnalytics: () => void;
  openAppearance: () => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  toggleFilePanel: () => void;
  toggleChatWidth: () => void;
  toggleFollowStream: () => void;
  setSkin: (skin: Skin) => void;
  setUiStyle: (style: UiStyle) => void;
  newSession: () => void;
  importSession: () => void;
  openParallelForActive: () => void;
  openHelp: () => void;
}

// ── Built-in action list ───────────────────────────────────────────────────

const ACTIONS: PaletteResult[] = [
  {
    id: "action:models",
    kind: "action",
    title: "Open Models",
    subtitle: "Configure providers, API keys, model selection",
    keywords: "provider api key llm 模型 設定",
    hint: "⇧⌘M",
    data: { action: "settings:models" } as { action: PaletteActionId },
  },
  {
    id: "action:skills",
    kind: "action",
    title: "Open Skills",
    subtitle: "Browse and toggle installed agent skills",
    keywords: "skill plugin extension 技能",
    hint: "⌘/",
    data: { action: "settings:skills" } as { action: PaletteActionId },
  },
  {
    id: "action:extensions",
    kind: "action",
    title: "Open Extensions",
    subtitle: "Loaded pi extensions: commands, tools, flags, diagnostics",
    keywords: "extension plugin command flag diagnostics 擴充",
    data: { action: "settings:extensions" } as { action: PaletteActionId },
  },
  {
    id: "action:prompts",
    kind: "action",
    title: "Prompt templates",
    subtitle: "Create and manage reusable prompts — insert with /name in the composer",
    keywords: "prompt template snippet reusable 範本 常用 提示",
    data: { action: "settings:prompts" } as { action: PaletteActionId },
  },
  {
    id: "action:analytics",
    kind: "action",
    title: "Open Analytics",
    subtitle: "Token usage and cost report for the active session",
    keywords: "stats tokens cost 分析 統計 成本",
    data: { action: "settings:analytics" } as { action: PaletteActionId },
  },
  {
    id: "action:appearance",
    kind: "action",
    title: "Open Appearance",
    subtitle: "Pick a skin and light/dark theme",
    keywords: "skin theme appearance picker 外觀 皮膚 主題",
    data: { action: "settings:appearance" } as { action: PaletteActionId },
  },
  {
    id: "action:toggle-theme",
    kind: "action",
    title: "Toggle Theme",
    subtitle: "Switch between light and dark mode",
    keywords: "dark light mode appearance 主題 深色 淺色",
    data: { action: "view:toggle-theme" } as { action: PaletteActionId },
  },
  {
    id: "action:toggle-sidebar",
    kind: "action",
    title: "Toggle Sidebar",
    subtitle: "Show or hide the session sidebar",
    hint: "⌘B",
    data: { action: "view:toggle-sidebar" } as { action: PaletteActionId },
  },
  {
    id: "action:toggle-file-panel",
    kind: "action",
    title: "Toggle File Panel",
    subtitle: "Show or hide the file viewer panel",
    hint: "⌘\\",
    data: { action: "view:toggle-file-panel" } as { action: PaletteActionId },
  },
  {
    id: "action:ui-style-original",
    kind: "action",
    title: "Interface: Original",
    subtitle: "Use the original Pi Web component geometry",
    keywords: "interface style original layout 介面 原版 版型",
    data: { action: "ui-style:original" } as { action: PaletteActionId },
  },
  {
    id: "action:ui-style-trae",
    kind: "action",
    title: "Interface: TRAE",
    subtitle: "Use the quieter TRAE-inspired component geometry",
    keywords: "interface style trae layout 介面 版型",
    data: { action: "ui-style:trae" } as { action: PaletteActionId },
  },
  {
    id: "action:skin-terminal",
    kind: "action",
    title: "Color: Terminal",
    subtitle: "Near-black with emerald",
    keywords: "skin theme appearance emerald green 外觀 風格 綠",
    data: { action: "skin:terminal" } as { action: PaletteActionId },
  },
  {
    id: "action:skin-trae",
    kind: "action",
    title: "Color: TRAE Violet",
    subtitle: "Neutral surfaces with a focused violet accent",
    keywords: "skin theme color appearance trae violet purple 配色 紫",
    data: { action: "skin:trae" } as { action: PaletteActionId },
  },
  {
    id: "action:skin-industrial",
    kind: "action",
    title: "Color: Industrial",
    subtitle: "Pure monochrome, high contrast",
    keywords: "skin theme appearance mono black white 外觀 風格 黑白",
    data: { action: "skin:industrial" } as { action: PaletteActionId },
  },
  {
    id: "action:skin-aurora",
    kind: "action",
    title: "Color: Aurora",
    subtitle: "Deep violet with soft glow",
    keywords: "skin theme appearance violet purple 外觀 風格 紫",
    data: { action: "skin:aurora" } as { action: PaletteActionId },
  },
  {
    id: "action:skin-editorial",
    kind: "action",
    title: "Color: Editorial",
    subtitle: "Warm paper tones with burnt orange",
    keywords: "skin theme appearance warm paper orange 外觀 風格 紙 橙",
    data: { action: "skin:editorial" } as { action: PaletteActionId },
  },
  {
    id: "action:skin-glass",
    kind: "action",
    title: "Color: Glass",
    subtitle: "Frosted panels over an aurora gradient",
    keywords: "skin theme appearance glass frost blur glassmorphism 外觀 風格 玻璃 磨砂",
    data: { action: "skin:glass" } as { action: PaletteActionId },
  },
  {
    id: "action:toggle-chat-width",
    kind: "action",
    title: "Toggle Wide Chat",
    subtitle: "Switch the conversation between normal and wide width",
    keywords: "width wide narrow layout 寬度",
    data: { action: "view:toggle-chat-width" } as { action: PaletteActionId },
  },
  {
    id: "action:toggle-follow",
    kind: "action",
    title: "Toggle Always-Follow Output",
    subtitle: "Keep the view pinned to streaming output, terminal-style (default off)",
    keywords: "follow scroll stream pin tail terminal auto 跟隨 捲動 黏底 自動",
    data: { action: "view:toggle-follow" } as { action: PaletteActionId },
  },
  {
    id: "action:new-session",
    kind: "action",
    title: "New Session",
    subtitle: "Start a fresh session in the active project",
    keywords: "create new chat 新增",
    data: { action: "session:new" } as { action: PaletteActionId },
  },
  {
    id: "action:import-session",
    kind: "action",
    title: "Import Pi Session",
    subtitle: "Preview and import an allowed local .jsonl session",
    keywords: "session import jsonl 匯入 對話",
    data: { action: "session:import" } as { action: PaletteActionId },
  },
  {
    id: "action:open-parallel",
    kind: "action",
    title: "Open Active Session in Parallel View",
    subtitle: "Side-by-side comparison with the current session",
    keywords: "split compare 並排 比較",
    data: { action: "session:open-parallel" } as { action: PaletteActionId },
  },
  {
    id: "action:help",
    kind: "action",
    title: "Keyboard Shortcuts",
    subtitle: "Show all available hotkeys",
    keywords: "hotkey help docs 快捷鍵 說明",
    data: { action: "help:shortcuts" } as { action: PaletteActionId },
  },
];

// ── Static actions result list (ref-safe, doesn't change between renders) ──
const ACTIONS_RESULTS: readonly PaletteResult[] = Object.freeze(ACTIONS);

// ── Fuse-lite scoring: substring scoring, exact-prefix and word-boundary
//    matches win ────────────────────────────────────────────────────────────

interface Score {
  value: number;
  matched: boolean;
}

function score(haystack: string, query: string): Score {
  if (!query) return { value: 0, matched: true };
  const h = haystack.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return { value: 0, matched: true };
  if (h === q) return { value: 1000, matched: true };
  if (h.startsWith(q)) return { value: 500, matched: true };
  // word-boundary match
  const wbIdx = h.search(new RegExp(`(?:^|\\b|[/_-])${escapeRegex(q)}`));
  if (wbIdx >= 0) return { value: 250 - wbIdx, matched: true };
  if (h.includes(q)) return { value: 100 - h.indexOf(q), matched: true };
  // fuzzy: every char of q appears in order
  let i = 0;
  for (let j = 0; j < h.length && i < q.length; j++) {
    if (h[j] === q[i]) i++;
  }
  if (i === q.length) return { value: 10, matched: true };
  return { value: 0, matched: false };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Hook ───────────────────────────────────────────────────────────────────

export interface UseCommandPaletteArgs {
  sessions: SessionInfo[];
  tags: SessionTags;
  /**
   * Currently active tag filter. When set, the command palette exposes a
   * "Clear filter" action so users can reset it.
   */
  activeTag?: string | null;
  onClearTag?: () => void;
}

export function useCommandPalette({
  sessions,
  tags,
  activeTag = null,
  onClearTag,
}: UseCommandPaletteArgs): CommandPaletteApi {
  const [query, setQuery] = useState("");
  const cbRef = useRef<PaletteCallbacks | null>(null);

  const open = useCallback(() => {
    setQuery("");
  }, []);

  const register = useCallback((cbs: PaletteCallbacks) => {
    cbRef.current = cbs;
  }, []);

  // ── Build result list ────────────────────────────────────────────────────
  const results = useMemo<PaletteResult[]>(() => {
    const all: PaletteResult[] = [];

    // Sessions
    for (const s of sessions) {
      const title = s.name?.trim() || s.firstMessage?.split("\n")[0]?.slice(0, 80) || s.id.slice(0, 8);
      const cwd = s.cwd ?? "";
      const sub = `${cwd} · ${s.messageCount} msg${s.messageCount === 1 ? "" : "s"}`;
      all.push({
        id: `session:${s.id}`,
        kind: "session",
        title,
        subtitle: sub,
        hint: s.id.slice(0, 8),
        data: s,
      });
    }

    // Tags — synthesise from the tags map
    const tagEntries = Object.entries(tags)
      .map(([tag, ids]) => ({ tag, count: ids.length }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    for (const { tag, count } of tagEntries) {
      all.push({
        id: `tag:${tag}`,
        kind: "tag",
        title: `#${tag}`,
        subtitle: `${count} session${count === 1 ? "" : "s"}`,
        data: { tag, count },
      });
    }

    // Active-tag clear filter action (if a filter is active)
    if (activeTag) {
      all.push({
        id: "action:clear-tag",
        kind: "action",
        title: `Clear tag filter (#${activeTag})`,
        subtitle: "Show all sessions",
        data: { action: "view:clear-tag" } as { action: PaletteActionId },
      });
    }

    // Built-in actions
    all.push(...ACTIONS_RESULTS);

    if (!query.trim()) {
      // The unified search panel uses this list for its Commands scope. Keep
      // actions ahead of large session catalogs so they are always available
      // before a query has been entered.
      return [
        ...all.filter((result) => result.kind === "action"),
        ...all.filter((result) => result.kind !== "action"),
      ].slice(0, 50);
    }

    // Score and filter
    const scored = all
      .map((r) => {
        const titleScore = score(r.title, query).value;
        const subScore = score(r.subtitle, query).value;
        const kwScore = r.keywords ? score(r.keywords, query).value : 0;
        const best = Math.max(titleScore, subScore, kwScore);
        return { r, best };
      })
      .filter(({ best }) => best > 0)
      .sort((a, b) => b.best - a.best)
      .slice(0, 50)
      .map(({ r }) => r);
    return scored;
  }, [sessions, tags, query, activeTag]);

  const runAction = useCallback((r: PaletteResult) => {
    const cbs = cbRef.current;
    // Session and tag selection are handled by the unified search panel.
    if (r.kind !== "action") return;
    const action = (r.data as { action: PaletteActionId }).action;
    if (action === "view:clear-tag") {
      onClearTag?.();
      return;
    }
    if (!cbs) return;
    switch (action) {
      case "settings:models": cbs.openModels(); break;
      case "settings:skills": cbs.openSkills(); break;
      case "settings:extensions": cbs.openExtensions(); break;
      case "settings:prompts": cbs.openPrompts(); break;
      case "settings:analytics": cbs.openAnalytics(); break;
      case "settings:appearance": cbs.openAppearance(); break;
      case "view:toggle-theme": cbs.toggleTheme(); break;
      case "view:toggle-sidebar": cbs.toggleSidebar(); break;
      case "view:toggle-file-panel": cbs.toggleFilePanel(); break;
      case "view:toggle-chat-width": cbs.toggleChatWidth(); break;
      case "view:toggle-follow": cbs.toggleFollowStream(); break;
      case "ui-style:original": cbs.setUiStyle("original"); break;
      case "ui-style:trae": cbs.setUiStyle("trae"); break;
      case "skin:trae": cbs.setSkin("trae"); break;
      case "skin:terminal": cbs.setSkin("terminal"); break;
      case "skin:industrial": cbs.setSkin("industrial"); break;
      case "skin:aurora": cbs.setSkin("aurora"); break;
      case "skin:editorial": cbs.setSkin("editorial"); break;
      case "skin:glass": cbs.setSkin("glass"); break;
      case "session:new": cbs.newSession(); break;
      case "session:import": cbs.importSession(); break;
      case "session:open-parallel": cbs.openParallelForActive(); break;
      case "help:shortcuts": cbs.openHelp(); break;
    }
  }, [onClearTag]);

  return {
    open,
    query,
    setQuery,
    results,
    runAction,
    register,
  };
}
