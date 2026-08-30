import path from "node:path";
import {
  isToolCallEventType,
  type InlineExtension,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { recordSecurityActivity } from "./security-activity";

export interface SafetyRisk {
  code:
    | "destructive-command"
    | "privileged-command"
    | "dependency-install"
    | "external-mutation"
    | "secret-access"
    | "protected-path"
    | "outside-workspace";
  title: string;
  explanation: string;
  operation: string;
}

export type SafetyAuthorizationScope = "once" | "exact-operation";

interface TimedSafetyGrant {
  expiresAt: number;
}

export const SAFETY_GRANT_TTL_MS = 5 * 60 * 1_000;
const ALLOW_ONCE = "Allow once";
const ALLOW_FOR_FIVE_MINUTES = "Allow this exact action for 5 minutes";

const CLIP_LENGTH = 520;
const MUTATING_CUSTOM_TOOL_RE = /(?:^|[_-])(delete|remove|destroy|publish|deploy|release|send[_-]?email|send[_-]?message|execute[_-]?trade|create[_-]?payment|write[_-]?file)(?:$|[_-])/i;
const SENSITIVE_BASENAME_RE = /^(?:\.env(?!\.(?:example|sample|template)$).*|\.npmrc|\.pypirc|credentials?(?:\.[^.]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|p12|pfx|key))$/i;
const PROTECTED_PATH_IN_COMMAND_PATTERNS = [
  /(?:^|[\s'"=:/\\])(?:\.env(?!\.(?:example|sample|template)(?:$|[\s'"/\\]))[^\s'"/\\]*|\.npmrc|\.pypirc|credentials?(?:\.[^\s'"/\\]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^\s'"/\\]+\.(?:pem|p12|pfx|key))(?=$|[\s'"/\\;|&<>])/i,
  /(?:^|[\s'"=:/\\])(?:\.git|\.ssh|\.aws|\.gnupg)(?:[/\\][^\s'";|&<>]*)?(?=$|[\s'";|&<>])/i,
  /(?:^|[\s'"=:/\\])\.github[/\\]workflows(?:[/\\][^\s'";|&<>]*)?(?=$|[\s'";|&<>])/i,
  /(?:^|[\s'"=:/\\])(?:setup\.sh|wrangler\.toml|docker-compose(?:\.[^\s'"/\\]+)?\.ya?ml)(?=$|[\s'"/\\;|&<>])/i,
];
const SHELL_PATH_MUTATION_RE = /(?:^|[;&|]\s*|\s)(?:rm|rmdir|mv|cp|install|touch|truncate|tee|chmod|chown|chgrp|ln|unlink|shred|dd|perl\s+-[^\s]*i|sed\s+-[^\s]*i|python3?|node|ruby|php|bash|zsh|sh|powershell|pwsh)\b|(?:^|\s)(?:npm|pnpm|yarn)\s+config\s+(?:set|delete)\b|(?:^|\s)git\s+config\s+(?!--get\b)/i;
const SHELL_OUTPUT_REDIRECT_RE = /(?:^|[^<])>>?\s*(?:['"])?[^\s'";|&]+/;
const PATH_OPERATING_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "sed", "awk", "grep", "rg", "find", "fd", "ls", "tree",
  "stat", "file", "du", "readlink", "realpath", "cp", "mv", "rm", "rmdir", "mkdir", "touch", "chmod",
  "chown", "chgrp", "ln", "tee", "truncate", "dd", "tar", "zip", "unzip", "git", "node", "python",
  "python3", "ruby", "php", "bash", "zsh", "sh", "powershell", "pwsh",
]);

function clip(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > CLIP_LENGTH ? `${singleLine.slice(0, CLIP_LENGTH - 1)}…` : singleLine;
}

function shellTokens(segment: string): string[] {
  return segment.match(/(?:[^\s'"`]+|'[^']*'|"[^"]*")+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? [];
}

function explicitPathValue(token: string): string | null {
  const value = token.replace(/^(?:--?[a-z][a-z0-9-]*=)/i, "").replace(/^[<>]+/, "");
  if (!value || /^(?:https?|ssh|git):\/\//i.test(value) || value === "/dev/null") return null;
  if (/^(?:~(?:[/\\]|$)|\$HOME(?:[/\\]|$)|\$\{HOME\}(?:[/\\]|$)|[/\\]|[A-Za-z]:[/\\])/.test(value)) return value;
  if (value.split(/[/\\]/).includes("..")) return value;
  return null;
}

function isOutsideWorkspacePath(candidate: string, cwd: string): boolean {
  if (/^[A-Za-z]:[/\\]/.test(candidate)) return true;
  if (/^(?:~|\$HOME|\$\{HOME\})(?:[/\\]|$)/.test(candidate)) return true;
  const absolute = path.resolve(cwd, candidate);
  const relative = path.relative(path.resolve(cwd), absolute);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function commandOutsideWorkspaceRisk(command: string, cwd: string): SafetyRisk | null {
  for (const match of command.matchAll(/(?:^|[^<])>{1,2}\s*(['"]?)([^\s'";&|]+)\1/g)) {
    const candidate = explicitPathValue(match[2] ?? "");
    if (candidate && isOutsideWorkspacePath(candidate, cwd)) {
      return {
        code: "outside-workspace",
        title: "Write outside this workspace",
        explanation: "This shell redirection targets a path outside the active project directory.",
        operation: clip(command),
      };
    }
  }
  for (const segment of command.split(/[|;&]+/)) {
    const tokens = shellTokens(segment);
    let commandIndex = tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
    if (commandIndex < 0) continue;
    while (["command", "env", "nice", "nohup"].includes(tokens[commandIndex])) {
      commandIndex += 1;
      while (tokens[commandIndex]?.startsWith("-")) commandIndex += 1;
    }
    const executable = path.basename(tokens[commandIndex] ?? "").toLowerCase();
    if (!PATH_OPERATING_COMMANDS.has(executable)) continue;
    for (const token of tokens.slice(commandIndex + 1)) {
      const candidate = explicitPathValue(token);
      if (candidate && isOutsideWorkspacePath(candidate, cwd)) {
        return {
          code: "outside-workspace",
          title: "Access a path outside this workspace",
          explanation: "This shell command directly references a path outside the active project directory.",
          operation: clip(command),
        };
      }
    }
  }
  return null;
}

function commandRisk(command: string, cwd: string): SafetyRisk | null {
  const operation = clip(command);
  const checks: Array<[RegExp, SafetyRisk["code"], string, string]> = [
    [/\brm\b(?=[^\n]*(?:\s--recursive\b|\s-[a-z]*r[a-z]*\b))/i, "destructive-command", "Delete files recursively", "This command can permanently remove a directory tree."],
    [/\bgit\s+(?:reset\s+--hard|clean\s+(?=[^\n]*-[a-z]*f)|checkout\s+--\s|checkout\b(?=[^\n]*(?:--force\b|-[a-z]*f[a-z]*\b))|switch\b(?=[^\n]*(?:--force\b|-[a-z]*f[a-z]*\b))|restore\b|branch\s+-D\b)/i, "destructive-command", "Discard Git working changes", "This command can remove uncommitted work or delete a local branch."],
    [/\b(?:mkfs(?:\.[a-z0-9]+)?|diskutil\s+erase|dd\s+[^\n]*\bof=|shutdown|reboot|halt)\b/i, "destructive-command", "Change or stop the host system", "This command can erase storage or interrupt the running host."],
    [/\b(?:chmod|chown)\b[^\n]*(?:\s-R\b|\s--recursive\b)/i, "privileged-command", "Change permissions recursively", "This command changes access across a directory tree."],
    [/\bsudo\b/i, "privileged-command", "Run a privileged command", "This command requests elevated operating-system access."],
    [/\b(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|install)|yarn\s+(?:add|install)|bun\s+(?:add|install)|pip(?:3)?\s+install|uv\s+(?:add|pip\s+install)|brew\s+install|apt(?:-get)?\s+install)\b/i, "dependency-install", "Install software or dependencies", "Installation can execute package scripts and change the environment."],
    [/\bgit\s+(?:config\s+(?!--get\b|--get-all\b|--list\b|--show-origin\b)|remote\s+(?:add|remove|rename|set-url))\b/i, "protected-path", "Change Git configuration", "This command modifies Git internals or repository remotes."],
    [/\b(?:gh\s+auth\s+(?:login|logout|refresh|setup-git)|npm\s+(?:login|logout|token\s+(?:create|revoke))|docker\s+(?:login|logout)|aws\s+configure|cloudflared\s+tunnel\s+login)\b/i, "secret-access", "Change stored credentials", "This command can create, refresh, or remove authentication material."],
    [/\b(?:git\s+push|gh\s+(?:pr\s+(?:create|merge|close|reopen|edit|review)|issue\s+(?:create|close|reopen|edit|delete)|release\s+(?:create|delete|edit|upload)|repo\s+(?:create|delete|archive|fork))|npm\s+publish|(?:wrangler|vercel|firebase|flyctl|railway)\s+(?:deploy|publish|delete|remove)|docker\s+push|kubectl\s+(?:apply|delete|create|patch|replace|scale)|terraform\s+(?:apply|destroy|import))\b/i, "external-mutation", "Change an external or production system", "This action can publish, deploy, merge, or modify remote state."],
    [/\bgh\s+api\b[^\n]*(?:(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b|(?:--input|-f|--field|-F|--raw-field)\b)/i, "external-mutation", "Change GitHub through its API", "This request can modify remote GitHub state."],
    [/\bcurl\b[^\n]*(?:(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|(?:--data(?:-ascii|-binary|-raw|-urlencode)?|-d|--form|-F|--upload-file|-T)\b)/i, "external-mutation", "Send a mutating HTTP request", "This request can change or upload data to an external system."],
    [/\bwget\b[^\n]*(?:--method[=\s]+(?:POST|PUT|PATCH|DELETE)\b|--post-(?:data|file)\b|--body-(?:data|file)\b)/i, "external-mutation", "Send a mutating HTTP request", "This request can change or upload data to an external system."],
    [/\b(?:curl|wget)\b[^\n|;&]*(?:\||--output|-o\s+)[^\n]*(?:\bsh\b|\bbash\b|\bzsh\b|\bpowershell\b)/i, "external-mutation", "Execute downloaded content", "Downloaded code would be passed directly into a command interpreter."],
  ];
  for (const [pattern, code, title, explanation] of checks) {
    if (pattern.test(command)) return { code, title, explanation, operation };
  }

  const mentionsSensitiveData = PROTECTED_PATH_IN_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
  if (mentionsSensitiveData && (SHELL_PATH_MUTATION_RE.test(command) || SHELL_OUTPUT_REDIRECT_RE.test(command))) {
    return {
      code: "protected-path",
      title: "Modify a protected path",
      explanation: "This command may change credentials, source control internals, automation, or deployment configuration.",
      operation,
    };
  }
  const readsOrTransfers = /\b(?:cat|sed|awk|head|tail|less|more|grep|rg|cp|scp|rsync|curl|wget|base64|openssl)\b/i.test(command);
  if (mentionsSensitiveData && readsOrTransfers) {
    return {
      code: "secret-access",
      title: "Access sensitive credentials",
      explanation: "This command may read, copy, or transmit authentication material.",
      operation,
    };
  }
  return commandOutsideWorkspaceRisk(command, cwd);
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (lowerSegments.some((segment) => [".git", ".ssh", ".aws", ".gnupg"].includes(segment))) return true;
  if (normalized.toLowerCase().includes("/.github/workflows/")) return true;
  const basename = segments.at(-1) ?? normalized;
  return SENSITIVE_BASENAME_RE.test(basename)
    || /^(?:setup\.sh|wrangler\.toml|docker-compose(?:\.[^.]+)?\.ya?ml)$/i.test(basename);
}

function pathRisk(filePath: string, cwd: string, action: "read" | "write"): SafetyRisk | null {
  const absolute = path.resolve(cwd, filePath);
  const relative = path.relative(path.resolve(cwd), absolute);
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  const operation = `${action === "write" ? "Modify" : "Read"} ${filePath}`;
  if (outside) {
    return {
      code: "outside-workspace",
      title: `${action === "write" ? "Modify" : "Read"} outside this workspace`,
      explanation: "The target is not contained by the active project directory.",
      operation,
    };
  }
  if (isSensitivePath(absolute)) {
    return {
      code: action === "read" ? "secret-access" : "protected-path",
      title: `${action === "write" ? "Modify" : "Read"} a protected path`,
      explanation: action === "write"
        ? "This file can affect credentials, source control, automation, or deployment."
        : "This file may contain credentials or other sensitive data.",
      operation,
    };
  }
  return null;
}

export function classifyToolCall(event: ToolCallEvent, cwd: string): SafetyRisk | null {
  if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
    return commandRisk(String(event.input.command ?? ""), cwd);
  }
  if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
    return pathRisk(String(event.input.path ?? ""), cwd, "write");
  }
  if (isToolCallEventType("read", event)) {
    return pathRisk(String(event.input.path ?? ""), cwd, "read");
  }
  if (MUTATING_CUSTOM_TOOL_RE.test(event.toolName)) {
    return {
      code: "external-mutation",
      title: "Run a mutating extension tool",
      explanation: "This extension action may change files or an external service.",
      operation: clip(`${event.toolName} ${JSON.stringify(event.input)}`),
    };
  }
  return null;
}

function safetyGrantKey(event: ToolCallEvent, risk: SafetyRisk, cwd: string): string {
  return JSON.stringify([path.resolve(cwd), event.toolName, risk.code, risk.operation]);
}

function pruneExpiredGrants(grants: Map<string, TimedSafetyGrant>, now: number): void {
  for (const [key, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(key);
  }
}

export function createSafetyGuardExtension(options: {
  recordActivity?: typeof recordSecurityActivity;
  now?: () => number;
  grantTtlMs?: number;
  grants?: Map<string, TimedSafetyGrant>;
} = {}): InlineExtension {
  const recordActivity = options.recordActivity ?? recordSecurityActivity;
  const now = options.now ?? Date.now;
  const grantTtlMs = options.grantTtlMs ?? SAFETY_GRANT_TTL_MS;
  const grants = options.grants ?? new Map<string, TimedSafetyGrant>();
  return {
    name: "Safety Guard",
    factory(pi) {
      pi.on("tool_call", async (event, ctx) => {
        const risk = classifyToolCall(event, ctx.cwd);
        if (!risk) return undefined;
        const checkedAt = now();
        pruneExpiredGrants(grants, checkedAt);
        const grantKey = safetyGrantKey(event, risk, ctx.cwd);
        const activeGrant = grants.get(grantKey);
        if (activeGrant && activeGrant.expiresAt > checkedAt) {
          recordActivity({
            category: "security",
            action: "authorize_tool",
            outcome: "reviewed",
            summary: `${risk.title} used an active time-limited approval`,
            target: event.toolName,
            cwd: ctx.cwd,
            details: {
              risk: risk.code,
              operation: risk.operation,
              authorizationScope: "exact-operation" satisfies SafetyAuthorizationScope,
              authorizationExpiresAt: new Date(activeGrant.expiresAt).toISOString(),
              reused: true,
            },
          });
          return undefined;
        }
        if (!ctx.hasUI) {
          recordActivity({
            category: "security",
            action: "authorize_tool",
            outcome: "denied",
            summary: `${risk.title} blocked because interactive confirmation was unavailable`,
            target: event.toolName,
            cwd: ctx.cwd,
            details: { risk: risk.code, operation: risk.operation, authorizationScope: "none" },
          });
          return { block: true, reason: `${risk.title} blocked because no interactive confirmation is available` };
        }
        const approved = await ctx.ui.confirm(
          `Allow: ${risk.title}?`,
          `${risk.explanation}\n\n${risk.operation}`,
        );
        if (!approved) {
          recordActivity({
            category: "security",
            action: "authorize_tool",
            outcome: "denied",
            summary: `${risk.title} was declined by the user`,
            target: event.toolName,
            cwd: ctx.cwd,
            details: { risk: risk.code, operation: risk.operation, authorizationScope: "none" },
          });
          return { block: true, reason: `${risk.title} was declined by the user` };
        }
        const duration = await ctx.ui.select(
          "Approval duration",
          [ALLOW_ONCE, ALLOW_FOR_FIVE_MINUTES],
        );
        const authorizationScope: SafetyAuthorizationScope = duration === ALLOW_FOR_FIVE_MINUTES
          ? "exact-operation"
          : "once";
        const authorizationExpiresAt = authorizationScope === "exact-operation"
          ? now() + grantTtlMs
          : now();
        if (authorizationScope === "exact-operation") {
          grants.set(grantKey, { expiresAt: authorizationExpiresAt });
        }
        recordActivity({
          category: "security",
          action: "authorize_tool",
          outcome: "reviewed",
          summary: authorizationScope === "exact-operation"
            ? `${risk.title} was approved for this exact action for 5 minutes`
            : `${risk.title} was approved once by the user`,
          target: event.toolName,
          cwd: ctx.cwd,
          details: {
            risk: risk.code,
            operation: risk.operation,
            authorizationScope,
            authorizationExpiresAt: new Date(authorizationExpiresAt).toISOString(),
            reused: false,
          },
        });
        return undefined;
      });
    },
  };
}
