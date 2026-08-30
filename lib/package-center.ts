import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DefaultPackageManager } from "@earendil-works/pi-coding-agent";

export type PackageScope = "user" | "project";
export type PackageSourceKind = "npm" | "git" | "local";

export type PackagePermissionId =
  | "hostCode"
  | "filesystem"
  | "process"
  | "network"
  | "credentials"
  | "modelInstructions"
  | "appearance"
  | "installScripts"
  | "binaries"
  | "dependencies";

export interface PackagePermission {
  id: PackagePermissionId;
  level: "declared" | "potential" | "warning";
  count: number;
}

export interface PackageInspection {
  source: string;
  resolvedSource: string;
  name: string;
  version: string;
  description?: string;
  license?: string;
  publisher?: string;
  repository?: string;
  integrity?: string;
  unpackedSize?: number;
  hasPiManifest: boolean;
  resources: string[];
  resourceEntries: Record<string, string[]>;
  dependencyCount: number;
  peerDependencyCount: number;
  lifecycleScripts: string[];
  binaries: string[];
  permissions: PackagePermission[];
}

export interface PackageMutationPreview {
  action: "install" | "remove" | "update";
  source: string;
  current?: PackageInspection;
  target?: PackageInspection;
  addedPermissions: PackagePermissionId[];
  removedPermissions: PackagePermissionId[];
}

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
  inspection?: PackageInspection;
  mutable: boolean;
}

interface NpmPackageManifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  license?: unknown;
  repository?: unknown;
  _npmUser?: { name?: unknown };
  maintainers?: Array<{ name?: unknown }>;
  pi?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
  bin?: string | Record<string, unknown>;
  dist?: { integrity?: unknown; shasum?: unknown; unpackedSize?: unknown };
}

const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;
const LIFECYCLE_SCRIPT_KEYS = ["preinstall", "install", "postinstall"] as const;

function stringEntries(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function repositoryUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "url" in value && typeof value.url === "string") return value.url;
  return undefined;
}

function permission(
  permissions: PackagePermission[],
  id: PackagePermissionId,
  level: PackagePermission["level"],
  count = 1,
) {
  if (count > 0) permissions.push({ id, level, count });
}

/** Build a conservative, manifest-only permission view without claiming code analysis. */
export function inspectPackageManifest(source: string, value: NpmPackageManifest): PackageInspection {
  const name = typeof value.name === "string" ? value.name : "unknown-package";
  const version = typeof value.version === "string" ? value.version : "unknown";
  const resourceEntries = Object.fromEntries(
    RESOURCE_KEYS.map((key) => [key, stringEntries(value.pi?.[key])]),
  ) as Record<string, string[]>;
  const resources = RESOURCE_KEYS.filter((key) => value.pi?.[key] !== undefined);
  const dependencyCount = value.dependencies && typeof value.dependencies === "object"
    ? Object.keys(value.dependencies).length
    : 0;
  const peerDependencyCount = value.peerDependencies && typeof value.peerDependencies === "object"
    ? Object.keys(value.peerDependencies).length
    : 0;
  const lifecycleScripts = LIFECYCLE_SCRIPT_KEYS.filter((key) => typeof value.scripts?.[key] === "string");
  const binaries = typeof value.bin === "string"
    ? [name]
    : value.bin && typeof value.bin === "object"
      ? Object.keys(value.bin)
      : [];
  const extensionCount = resourceEntries.extensions.length || (value.pi?.extensions !== undefined ? 1 : 0);
  const instructionCount = resourceEntries.skills.length + resourceEntries.prompts.length
    || (value.pi?.skills !== undefined || value.pi?.prompts !== undefined ? 1 : 0);
  const themeCount = resourceEntries.themes.length || (value.pi?.themes !== undefined ? 1 : 0);
  const permissions: PackagePermission[] = [];
  if (extensionCount > 0) {
    permission(permissions, "hostCode", "declared", extensionCount);
    for (const id of ["filesystem", "process", "network", "credentials"] as const) {
      permission(permissions, id, "potential");
    }
  }
  permission(permissions, "modelInstructions", "declared", instructionCount);
  permission(permissions, "appearance", "declared", themeCount);
  permission(permissions, "installScripts", "warning", lifecycleScripts.length);
  permission(permissions, "binaries", "declared", binaries.length);
  permission(permissions, "dependencies", "declared", dependencyCount);

  const publisher = typeof value._npmUser?.name === "string"
    ? value._npmUser.name
    : typeof value.maintainers?.[0]?.name === "string"
      ? value.maintainers[0].name
      : undefined;
  const integrity = typeof value.dist?.integrity === "string"
    ? value.dist.integrity
    : typeof value.dist?.shasum === "string"
      ? `sha1-${value.dist.shasum}`
      : undefined;

  return {
    source,
    resolvedSource: `npm:${name}@${version}`,
    name,
    version,
    description: typeof value.description === "string" ? value.description : undefined,
    license: typeof value.license === "string" ? value.license : undefined,
    publisher,
    repository: repositoryUrl(value.repository),
    integrity,
    unpackedSize: typeof value.dist?.unpackedSize === "number" ? value.dist.unpackedSize : undefined,
    hasPiManifest: !!value.pi && typeof value.pi === "object",
    resources,
    resourceEntries,
    dependencyCount,
    peerDependencyCount,
    lifecycleScripts,
    binaries,
    permissions,
  };
}

export function parseNpmPackageSource(sourceValue: unknown): { source: string; name: string; selector: string } {
  const source = normalizeNpmPackageSource(sourceValue);
  const spec = source.startsWith("npm:") ? source.slice(4) : source;
  const separator = spec.lastIndexOf("@");
  const nameBoundary = spec.startsWith("@") ? spec.indexOf("/") : -1;
  const hasSelector = separator > nameBoundary;
  return {
    source,
    name: hasSelector ? spec.slice(0, separator) : spec,
    selector: hasSelector ? spec.slice(separator + 1) : "latest",
  };
}

export async function inspectNpmPackageSource(
  sourceValue: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<PackageInspection> {
  const parsed = parseNpmPackageSource(sourceValue);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(parsed.name)}/${encodeURIComponent(parsed.selector)}`;
    const response = await fetchImpl(url, {
      headers: { Accept: "application/vnd.npm.install-v1+json, application/json" },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const manifest = await response.json() as NpmPackageManifest;
    if (manifest.name !== parsed.name || typeof manifest.version !== "string") {
      throw new Error("npm registry returned an unexpected package manifest");
    }
    return inspectPackageManifest(parsed.source, manifest);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Package inspection timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildPackageMutationPreview(
  action: PackageMutationPreview["action"],
  source: string,
  current?: PackageInspection,
  target?: PackageInspection,
): PackageMutationPreview {
  const currentIds = new Set(current?.permissions.map((item) => item.id) ?? []);
  const targetIds = new Set(target?.permissions.map((item) => item.id) ?? []);
  return {
    action,
    source,
    current,
    target,
    addedPermissions: [...targetIds].filter((id) => !currentIds.has(id)),
    removedPermissions: [...currentIds].filter((id) => !targetIds.has(id)),
  };
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

function readInstalledMetadata(installedPath?: string, source = ""): Pick<PackageCenterEntry, "name" | "version" | "resources" | "inspection"> {
  if (!installedPath) return { resources: [] };
  const packageJsonPath = join(installedPath, "package.json");
  if (!existsSync(packageJsonPath)) return { resources: [] };
  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as NpmPackageManifest;
    const inspection = inspectPackageManifest(source, manifest);
    return {
      name: typeof manifest.name === "string" ? manifest.name : undefined,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
      resources: inspection.resources,
      inspection,
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
      ...readInstalledMetadata(item.installedPath, item.source),
    };
  }).sort((a, b) => (a.scope === b.scope ? a.source.localeCompare(b.source) : a.scope === "user" ? -1 : 1));
}
