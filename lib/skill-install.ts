import path from "path";

export type SkillInstallScope = "global" | "project";

export interface SkillInstallTarget {
  source: string;
  scope: SkillInstallScope;
  cwd?: string;
  installPath: string;
  fingerprint: string;
}

export class SkillInstallValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The skills CLI accepts a GitHub repository plus one skill name. Keep that
 * narrow contract at the web boundary instead of forwarding arbitrary URLs,
 * paths, credentials, or CLI-like values to npx.
 */
export function normalizeSkillSource(value: unknown): string {
  if (typeof value !== "string") throw new SkillInstallValidationError("Skill source is required");
  const source = value.trim();
  if (!source) throw new SkillInstallValidationError("Skill source is required");
  if (source.length > 302 || /[\u0000-\u001f\u007f\s\\?#%]/.test(source) || source.includes("://")) {
    throw new SkillInstallValidationError("Use a skills.sh source such as owner/repo@skill");
  }

  const match = source.match(/^@?([^/]+)\/([^@/]+)@([^@/]+)$/);
  if (!match || !match.slice(1).every((segment) => SEGMENT_RE.test(segment) && segment !== "." && segment !== "..")) {
    throw new SkillInstallValidationError("Use a skills.sh source such as owner/repo@skill");
  }
  return `${match[1]}/${match[2]}@${match[3]}`;
}

export function resolveSkillInstallTarget(
  input: { source: unknown; scope: unknown; cwd?: unknown },
  knownSessionCwds: Iterable<string>,
): SkillInstallTarget {
  const source = normalizeSkillSource(input.source);
  if (input.scope !== "global" && input.scope !== "project") {
    throw new SkillInstallValidationError("Install scope must be global or project");
  }
  const scope = input.scope;
  let cwd: string | undefined;

  if (scope === "project") {
    if (typeof input.cwd !== "string" || !input.cwd.trim()) {
      throw new SkillInstallValidationError("A project workspace is required");
    }
    cwd = path.resolve(input.cwd.trim());
    const allowed = new Set(Array.from(knownSessionCwds, (candidate) => path.resolve(candidate)));
    if (!allowed.has(cwd)) {
      throw new SkillInstallValidationError("Open this project in a session before installing a project Skill", 403);
    }
  }

  const installPath = scope === "global" ? "~/.pi/agent/skills/" : path.join(cwd!, ".pi", "agent", "skills");
  const fingerprint = JSON.stringify({ source, scope, cwd: cwd ?? "" });
  return { source, scope, cwd, installPath, fingerprint };
}
