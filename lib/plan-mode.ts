import {
  isToolCallEventType,
  type InlineExtension,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { TOOL_PRESET_PLAN } from "./tool-selection";

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /\bfind\b[^\n]*(?:-delete|-exec|-execdir)\b/i,
  /\bfind\b[^\n]*-(?:fprint0?|fprintf|fls)\b/i,
  /\brg\b[^\n]*--pre(?:=|\s)/i,
  /\bsort\b[^\n]*(?:\s-o\S*|--output(?:=|\s))/i,
  /\bgit\b[^\n]*(?:--output(?:=|\s)|--ext-diff|--textconv)/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|update|ci|link|publish)\b/i,
  /\b(?:pip|pip3|uv)\s+(?:install|uninstall|add|remove)\b/i,
  /\b(?:apt|apt-get|brew)\s+(?:install|remove|purge|update|upgrade|uninstall)\b/i,
  /\bgit\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|init|clone|clean)\b/i,
  /\b(?:sudo|su|kill|pkill|killall|reboot|shutdown)\b/i,
  /\b(?:systemctl|service|launchctl)\b/i,
  /\b(?:vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_SEGMENT_PATTERNS = [
  /^\s*(?:cat|head|tail|grep|rg|find|ls|pwd|echo|printf|wc|sort|diff|file|stat|du|df|tree|which|whereis|type|printenv|uname|whoami|id|cal|uptime|ps|free|jq)\b/i,
  /^\s*git\s+(?:status|log|diff|show|ls-files|ls-tree|config\s+--get)\b/i,
  /^\s*(?:npm|pnpm|yarn)\s+(?:list|ls|view|info|search|outdated|audit|why)\b/i,
  /^\s*(?:node|python|python3|ruby|go|rustc|cargo)\s+--version\b/i,
  /^\s*curl\s+(?:-I|--head)\s+https?:\/\/[^\s]+$/,
];

const SHELL_CONTROL_RE = /[\r\n;&`$()<>\\]|\|\|/;

export const PLAN_MODE_PROMPT = `[PLAN MODE ACTIVE]
This is a planning-only turn. Explore the workspace and return a safe, implementation-ready plan.

Rules:
- Do not modify files, dependencies, Git state, services, or external systems.
- The edit and write tools are unavailable.
- Bash accepts only allowlisted read-only inspection commands.
- Use ask_user only when a missing decision would materially change the plan.
- Inspect the existing implementation before proposing changes and cite concrete files or symbols.
- Save the steps with update_plan and summarize naturally. Use structured_output only when a result card helps. Independent steps may run in parallel after execution is authorized.
- Do not claim that the plan has been implemented.`;

function normalizedToolSet(names: readonly string[]): string {
  // Existing saved Plan selections predate workflow tools; management tools
  // must not accidentally disable their read-only guard.
  return [...new Set(names.filter(name => name !== "update_plan" && name !== "goal_status"))].sort().join(",");
}

export function isPlanToolSelection(names: readonly string[]): boolean {
  return normalizedToolSet(names) === normalizedToolSet(TOOL_PRESET_PLAN);
}

/**
 * Official Pi plan mode uses a read-only command allowlist. The Web version is
 * deliberately stricter around shell control operators so a safe-looking first
 * command cannot hide a mutating second command.
 */
export function isPlanReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_CONTROL_RE.test(trimmed)) return false;
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  // Handle common read-only forms without allowing arbitrary interpreter code,
  // git configuration overrides, sed scripts, or shell command substitution.
  const normalized = trimmed.replace(/^git\s+(?:-C\s+(?:"[^"\n]+"|'[^'\n]+'|[^\s]+)\s+)+/, "git ");
  const sed = normalized.match(/^sed\s+-n\s+(?:'\d+(?:,\d+)?p'|"\d+(?:,\d+)?p"|\d+(?:,\d+)?p)\s+(.+)$/);
  if (sed) {
    if (/[*?\[\]]/.test(sed[1])) return false;
    // Only literal file arguments after a print expression; no extra scripts/options.
    return /^(?:"[^"\n]+"|'[^'\n]+'|[^\s'"|]+)(?:\s+(?:"[^"\n]+"|'[^'\n]+'|[^\s'"|]+))*$/.test(sed[1])
      && (sed[1].match(/"[^"\n]+"|'[^'\n]+'|[^\s]+/g) ?? []).every(file => !file.replace(/^['"]/, "").startsWith("-"));
  }
  const segments = normalized.split("|").map((segment) => segment.trim()).filter(Boolean);
  return segments.length > 0 && segments.every((segment) => SAFE_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment)));
}

export function planModeToolCallDecision(event: ToolCallEvent): { block: true; reason: string } | undefined {
  if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
    return { block: true, reason: "Plan mode is read-only. Switch the tool preset before changing files." };
  }
  if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
    const command = String(event.input.command ?? "");
    if (!isPlanReadOnlyCommand(command)) {
      return {
        block: true,
        reason: `Plan mode blocked a command that is not on the read-only allowlist: ${command}`,
      };
    }
  }
  return undefined;
}

export function createPlanModeExtension(): InlineExtension {
  return {
    name: "Plan Mode",
    factory(pi) {
      const active = () => isPlanToolSelection(pi.getActiveTools());

      pi.on("before_agent_start", async (event) => {
        if (!active()) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_PROMPT}` };
      });

      pi.on("tool_call", async (event) => {
        if (!active()) return undefined;
        return planModeToolCallDecision(event);
      });
    },
  };
}
