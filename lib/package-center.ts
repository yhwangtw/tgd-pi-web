import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DefaultPackageManager } from "@earendil-works/pi-coding-agent";

export type PackageScope = "user" | "project";
export type PackageSourceKind = "npm" | "git" | "local";

export interface PackageCenterEntry {
  source: string;
  scope: PackageScope;
  kind: PackageSourceKind;
  filtered: boolean;
  pinned: boolean;
  installed: boolean;
  installedPath?: string;
  name?: string;
  version?: string;
  resources: string[];
  mutable: boolean;
}

export function normalizeNpmPackageSource(value: unknown): string {
  if (typeof value !== "string") throw new Error("Package source is required");
  const source = value.trim();
  if (!source || source.length > 214) throw new Error("Enter a valid npm package name");
  const pattern = /^(?:npm:)?(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]*)(?:@[a-z0-9][a-z0-9._~+*-]*)?$/i;
  if (!pattern.test(source)) throw new Error("Only npm package names are supported in the safe package center");
  return source;
}

export function packageSourceKind(source: string): PackageSourceKind {
  if (source.startsWith("git:") || /^(?:https?|ssh):\/\//.test(source) || /^[\w.-]+@[\w.-]+:/.test(source)) return "git";
  if (source.startsWith("npm:") || /^@?[\w.-]+(?:\/[\w.-]+)?(?:@[^/]+)?$/.test(source)) return "npm";
  return "local";
}

export function isPinnedPackageSource(source: string): boolean {
  const kind = packageSourceKind(source);
  if (kind === "local") return false;
  if (kind === "npm") {
    const spec = source.startsWith("npm:") ? source.slice(4) : source;
    const lastAt = spec.lastIndexOf("@");
    return lastAt > (spec.startsWith("@") ? spec.indexOf("/") : -1);
  }
  const lastAt = source.lastIndexOf("@");
  return lastAt > source.indexOf(":") + 1;
}

function readInstalledMetadata(installedPath?: string): Pick<PackageCenterEntry, "name" | "version" | "resources"> {
  if (!installedPath) return { resources: [] };
  const packageJsonPath = join(installedPath, "package.json");
  if (!existsSync(packageJsonPath)) return { resources: [] };
  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
      pi?: Record<string, unknown>;
    };
    const resources = ["extensions", "skills", "prompts", "themes"].filter((key) => manifest.pi?.[key] !== undefined);
    return {
      name: typeof manifest.name === "string" ? manifest.name : undefined,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
      resources,
    };
  } catch {
    return { resources: [] };
  }
}

export function describeConfiguredPackages(
  manager: Pick<DefaultPackageManager, "listConfiguredPackages">,
): PackageCenterEntry[] {
  const configured = manager.listConfiguredPackages();
  const projectSources = new Set(configured.filter((item) => item.scope === "project").map((item) => item.source));
  return configured.map((item) => {
    const kind = packageSourceKind(item.source);
    return {
      source: item.source,
      scope: item.scope,
      kind,
      filtered: item.filtered,
      pinned: isPinnedPackageSource(item.source),
      installed: !!item.installedPath && existsSync(item.installedPath),
      installedPath: item.installedPath,
      mutable: item.scope === "user" && kind === "npm" && !projectSources.has(item.source),
      ...readInstalledMetadata(item.installedPath),
    };
  }).sort((a, b) => (a.scope === b.scope ? a.source.localeCompare(b.source) : a.scope === "user" ? -1 : 1));
}
