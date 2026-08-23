export const TOOL_PRESETS = ["inherit", "off", "default", "full", "custom"] as const;
export const TOOL_PRESET_MAP = {
  inherit: "inherit",
  off: "none",
  default: "default",
  full: "full",
  custom: "custom",
} as const;
export const COMPOSITION_END_ENTER_GRACE_MS = 100;

export const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevelOption = typeof THINKING_LEVELS[number];

// tGD 7-phase slash commands
export const TGD_COMMANDS = [
  { name: "/tgd-map", description: "Map — understand the codebase" },
  { name: "/tgd-define", description: "Define — write the PRD" },
  { name: "/tgd-plan", description: "Plan — break into tasks" },
  { name: "/tgd-develop", description: "Develop — implement features" },
  { name: "/tgd-verify", description: "Verify — run tests" },
  { name: "/tgd-review", description: "Review — code review" },
  { name: "/tgd-release", description: "Release — ship to production" },
];

// A single entry in the composer's `/` menu. `insert` is what replaces the
// composer text on select: tGD commands insert `/name ` (the agent resolves
// it), user prompt templates insert their full body text.
export interface SlashItem {
  name: string;
  description: string;
  insert: string;
  /** true for user-defined prompt templates (vs built-in tGD commands) */
  isTemplate?: boolean;
}

function firstLine(body: string): string {
  const line = body.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** Combine the built-in tGD commands with the user's saved prompt templates. */
export function buildSlashItems(prompts: { name: string; body: string }[]): SlashItem[] {
  return [
    ...TGD_COMMANDS.map((c) => ({ name: c.name, description: c.description, insert: `${c.name} ` })),
    ...prompts.map((p) => ({ name: `/${p.name}`, description: firstLine(p.body), insert: p.body, isTemplate: true })),
  ];
}
