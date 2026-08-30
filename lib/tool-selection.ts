export type ToolSelectionMode = "inherit" | "none" | "plan" | "default" | "full" | "custom";

export interface ToolCatalogEntry {
  name: string;
  description: string;
  active: boolean;
  label?: string;
  source?: "builtin" | "extension" | "sdk" | "mcp";
}

export interface ToolSelectionState {
  mode: ToolSelectionMode;
  selectedNames: string[];
  tools: ToolCatalogEntry[];
}

export const TOOL_PRESET_NONE: string[] = [];
export const TOOL_PRESET_PLAN = ["read", "bash", "grep", "find", "ls", "ask_user", "structured_output"] as const;
export const TOOL_PRESET_DEFAULT = ["read", "bash", "edit", "write", "ask_user", "structured_output"] as const;
export const TOOL_PRESET_FULL = ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_user", "structured_output"] as const;

export const DEFAULT_TOOL_CATALOG: ToolCatalogEntry[] = [
  { name: "read", description: "Read file contents", active: true, source: "builtin" },
  { name: "bash", description: "Run shell commands", active: true, source: "builtin" },
  { name: "edit", description: "Edit existing files", active: true, source: "builtin" },
  { name: "write", description: "Create or replace files", active: true, source: "builtin" },
  { name: "grep", description: "Search file contents", active: false, source: "builtin" },
  { name: "find", description: "Find files by pattern", active: false, source: "builtin" },
  { name: "ls", description: "List directories", active: false, source: "builtin" },
  { name: "ask_user", description: "Ask focused questions and wait for answers", active: true, source: "sdk" },
  { name: "structured_output", description: "Finish with a structured result card", active: true, source: "sdk" },
];

export function namesForToolSelection(mode: ToolSelectionMode, customNames: string[] = []): string[] | undefined {
  if (mode === "inherit") return undefined;
  if (mode === "none") return [];
  if (mode === "plan") return [...TOOL_PRESET_PLAN];
  if (mode === "default") return [...TOOL_PRESET_DEFAULT];
  if (mode === "full") return [...TOOL_PRESET_FULL];
  return [...new Set(customNames.filter(Boolean))];
}

export function inferToolSelectionMode(names: readonly string[] | undefined): ToolSelectionMode {
  if (names === undefined) return "inherit";
  const normalized = [...new Set(names)].sort().join(",");
  if (!normalized) return "none";
  if (normalized === [...TOOL_PRESET_PLAN].sort().join(",")) return "plan";
  if (normalized === [...TOOL_PRESET_DEFAULT].sort().join(",")) return "default";
  if (normalized === [...TOOL_PRESET_FULL].sort().join(",")) return "full";
  return "custom";
}
