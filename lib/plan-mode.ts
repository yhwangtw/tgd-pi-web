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
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|update|ci|link|publish)\b/i,
  /\b(?:pip|pip3|uv)\s+(?:install|uninstall|add|remove)\b/i,
  /\b(?:apt|apt-get|brew)\s+(?:install|remove|purge|update|upgrade|uninstall)\b/i,
  /\bgit\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|init|clone|clean)\b/i,
  /\b(?:sudo|su|kill|pkill|killall|reboot|shutdown)\b/i,
  /\b(?:systemctl|service|launchctl)\b/i,
  /\b(?:vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_SEGMENT_PATTERNS = [
  /^\s*(?:cat|head|tail|less|more|grep|rg|find|fd|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|cal|uptime|ps|top|htop|free|jq|bat|eza)\b/i,
  /^\s*sed\s+-n\b/i,
  /^\s*git\s+(?:status|log|diff|show|branch|remote|ls-[a-z-]+|config\s+--get)\b/i,
  /^\s*(?:npm|pnpm|yarn)\s+(?:list|ls|view|info|search|outdated|audit|why)\b/i,
  /^\s*(?:node|python|python3|ruby|go|rustc|cargo)\s+--version\b/i,
  /^\s*curl\s+(?!(?:.|\n)*(?:--data(?:-raw|-binary|-urlencode)?\b|-d\b|--form\b|-F\b|--upload-file\b|-T\b|-X\s*(?!GET\b|HEAD\b)|--request\s*(?!GET\b|HEAD\b)))/i,
  /^\s*wget\s+(?:-q\s+)?-O\s+-(?:\s|$)/i,
];

const SHELL_CONTROL_RE = /(?:\r|\n|;|&&|\|\||`|\$\(|[<>])/;

export const PLAN_MODE_PROMPT = `[PLAN MODE ACTIVE]
This is a planning-only turn. Explore the workspace and return a safe, implementation-ready plan.

Rules:
- Do not modify files, dependencies, Git state, services, or external systems.
- The edit and write tools are unavailable.
- Bash accepts only allowlisted read-only inspection commands.
- Use ask_user only when a missing decision would materially change the plan.
- Inspect the existing implementation before proposing changes and cite concrete files or symbols.
- Finish with structured_output. Put a short conclusion in summary and the ordered implementation steps in actionItems.
- Do not claim that the plan has been implemented.`;

function normalizedToolSet(names: readonly string[]): string {
  return [...new Set(names)].sort().join(",");
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
  const segments = trimmed.split("|").map((segment) => segment.trim()).filter(Boolean);
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
