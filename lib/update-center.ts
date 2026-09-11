import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSupportedNodeVersion, NODE_SUPPORT_DESCRIPTION } from "./node-support.mjs";
import { AUTH_COOKIE, gateEnabled, issueAccessToken } from "./access-gate";
import { createRuntimeIdentity, type RuntimeIdentity } from "./runtime-identity";
import { finishUpdateOperation, listUpdateOperations, readUpdateOperation, reserveUpdateOperation } from "../scripts/update-operation-store.mjs";
import { validateIdentityUrl } from "../scripts/managed-update-runner.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_RELEASE_REPOSITORY = "yhwangtw/tgd-pi-web";
const RELEASE_CACHE_TTL_MS = 5 * 60_000;
const MIN_BACKUP_BYTES = 512 * 1024 * 1024;
const MAX_RELEASE_NOTES = 24_000;
const MANAGED_ACTION_ENV = {
  update: "PIWEB_UPDATE_COMMAND_JSON",
  restart: "PIWEB_RESTART_COMMAND_JSON",
  rollback: "PIWEB_ROLLBACK_COMMAND_JSON",
} as const;

export type UpdateCenterAction = "backup" | "update" | "restart" | "rollback";
export type ManagedUpdateAction = Exclude<UpdateCenterAction, "backup">;
export type UpdateCheckState = "pass" | "warning" | "fail";

export interface ManagedCommand {
  executable: string;
  args: string[];
}

export interface ManagedActionStatus {
  configured: boolean;
  ready: boolean;
  label?: string;
  reason?: "not_configured" | "invalid_config" | "not_executable" | "health_not_configured" | "staging_not_configured";
}

export interface UpdateOperation {
  id: string;
  action: ManagedUpdateAction;
  status: "reserved" | "running" | "verifying" | "succeeded" | "failed" | "verification_failed" | "interrupted";
  pid: number;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  message?: string;
  requiresRecovery?: boolean;
  rollbackVerified?: boolean;
  verified?: { pid: number; startedAt: string; build: RuntimeIdentity["build"] };
}

export interface UpdateBackup {
  id: string;
  createdAt: string;
  path: string;
  source: "git" | "archive";
  version: string;
  head?: string;
  branch?: string;
  dirty: boolean;
  untrackedFiles: number;
}

export interface UpdatePreflightCheck {
  id: "node" | "release" | "source" | "backup" | "workspace" | "updater" | "restart";
  state: UpdateCheckState;
  detail: string;
}

export interface UpdateCenterStatus {
  checkedAt: string;
  running?: RuntimeIdentity;
  operations?: { active: UpdateOperation | null; recent: UpdateOperation[] };
  current: {
    version: string;
    source: "git" | "archive";
    head?: string;
    branch?: string;
    dirty: boolean;
    changedFiles: number;
    untrackedFiles: number;
    sourceFingerprint: string;
  };
  latest: {
    version?: string;
    tag?: string;
    name?: string;
    url: string;
    publishedAt?: string;
    notes?: string;
    error?: string;
  };
  updateAvailable: boolean | null;
  preflight: {
    ready: boolean;
    checks: UpdatePreflightCheck[];
  };
  backup: {
    root: string;
    writable: boolean;
    freeBytes?: number;
    latest?: UpdateBackup;
    recent: UpdateBackup[];
  };
  actions: Record<ManagedUpdateAction, ManagedActionStatus> & {
    backup: ManagedActionStatus;
  };
  dataImpact: {
    preservesAgentData: true;
    sourceMayChange: true;
    requiresRestart: true;
  };
  commands: {
    update: string;
    restart: string;
    rollback: string;
  };
}

interface LatestReleaseCache {
  at: number;
  repository: string;
  value: UpdateCenterStatus["latest"];
}

interface CheckoutStatus {
  source: "git" | "archive";
  head?: string;
  branch?: string;
  dirty: boolean;
  changedFiles: number;
  untrackedFiles: number;
  statusText: string;
}

interface UpdateCenterOptions {
  cwd?: string;
  backupRoot?: string;
  env?: NodeJS.ProcessEnv;
  forceReleaseRefresh?: boolean;
}

interface CreateBackupOptions {
  cwd?: string;
  backupRoot?: string;
  version?: string;
}

declare global {
  var __piWebLatestReleaseCache: LatestReleaseCache | undefined;
  var __piWebRuntimeStartedAt: string | undefined;
}

function operationRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PIWEB_UPDATE_OPERATION_DIR ?? join(getAgentDir(), "updates", "operations");
}

function runningIdentity(): RuntimeIdentity {
  // Keep literal env accesses: Next inlines build metadata at compile time.
  // Disk package.json/HEAD may already belong to a staged/newer source tree.
  return createRuntimeIdentity(process.env, {
    agentDir: getAgentDir(), cwd: process.cwd(), pid: process.pid,
    startedAt: globalThis.__piWebRuntimeStartedAt ??= new Date(Date.now() - process.uptime() * 1000).toISOString(),
  }, {
    version: process.env.NEXT_PUBLIC_APP_VERSION || "unknown",
    sourceSha: process.env.PIWEB_BUILD_SHA || null,
    dirty: process.env.PIWEB_BUILD_DIRTY ? process.env.PIWEB_BUILD_DIRTY === "true" : null,
    builtAt: process.env.PIWEB_BUILD_TIME || null,
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathInside(parent: string, candidate: string): boolean {
  const nested = relative(parent, candidate);
  return nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested));
}

async function jsonVersion(cwd: string): Promise<string> {
  const body = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { version?: string };
  return body.version ?? "unknown";
}

async function git(args: string[], cwd: string, timeout = 8_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  return stdout.trimEnd();
}

async function checkoutStatus(cwd: string): Promise<CheckoutStatus> {
  try {
    const inside = await git(["rev-parse", "--is-inside-work-tree"], cwd);
    if (inside !== "true") throw new Error("not a git checkout");
    const [head, branch, statusText] = await Promise.all([
      git(["rev-parse", "HEAD"], cwd),
      git(["branch", "--show-current"], cwd),
      git(["status", "--porcelain=v1", "--untracked-files=all"], cwd),
    ]);
    const lines = statusText ? statusText.split("\n") : [];
    const untrackedFiles = lines.filter((line) => line.startsWith("?? ")).length;
    return {
      source: "git",
      head,
      branch: branch || "detached",
      dirty: lines.length > 0,
      changedFiles: lines.length,
      untrackedFiles,
      statusText,
    };
  } catch {
    return {
      source: "archive",
      dirty: false,
      changedFiles: 0,
      untrackedFiles: 0,
      statusText: "",
    };
  }
}

function parsedCalendarVersion(version: string): [number, number, number, number] | null {
  const match = version.replace(/^v/, "").match(/^(\d{4})\.(\d{2})\.(\d{2})(?:-([1-9]\d*))?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
}

export function compareCalendarVersions(left: string, right: string): number {
  const a = parsedCalendarVersion(left);
  const b = parsedCalendarVersion(right);
  if (a && b) {
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
    }
    return 0;
  }
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

function releaseRepository(env: NodeJS.ProcessEnv): string {
  const value = env.PIWEB_RELEASE_REPOSITORY?.trim() || DEFAULT_RELEASE_REPOSITORY;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : DEFAULT_RELEASE_REPOSITORY;
}

async function latestRelease(env: NodeJS.ProcessEnv, force = false): Promise<UpdateCenterStatus["latest"]> {
  const repository = releaseRepository(env);
  const cached = globalThis.__piWebLatestReleaseCache;
  if (!force && cached && cached.repository === repository && Date.now() - cached.at < RELEASE_CACHE_TTL_MS) {
    return cached.value;
  }
  const fallbackUrl = `https://github.com/${repository}/releases`;
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "tgd-pi-web-update-center" },
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new Error(`GitHub Releases HTTP ${response.status}`);
    const body = await response.json() as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      published_at?: string;
      body?: string;
    };
    if (!body.tag_name) throw new Error("Latest release has no tag");
    const value: UpdateCenterStatus["latest"] = {
      version: body.tag_name.replace(/^v/, ""),
      tag: body.tag_name,
      name: body.name || body.tag_name,
      url: body.html_url || fallbackUrl,
      publishedAt: body.published_at,
      notes: body.body?.slice(0, MAX_RELEASE_NOTES),
    };
    globalThis.__piWebLatestReleaseCache = { at: Date.now(), repository, value };
    return value;
  } catch (error) {
    const value = { url: fallbackUrl, error: errorText(error) };
    globalThis.__piWebLatestReleaseCache = { at: Date.now(), repository, value };
    return value;
  }
}

export function parseManagedUpdateCommand(value: string | undefined): ManagedCommand | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Managed command must be a JSON argv array");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32 || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Managed command must contain 1-32 string arguments");
  }
  const [executable, ...args] = parsed as string[];
  if (!isAbsolute(executable) || executable.includes("\0")) {
    throw new Error("Managed command executable must be an absolute path");
  }
  if (args.some((item) => item.includes("\0") || item.length > 4_096)) {
    throw new Error("Managed command contains an invalid argument");
  }
  return { executable, args };
}

async function managedActionStatus(action: ManagedUpdateAction, env: NodeJS.ProcessEnv): Promise<ManagedActionStatus> {
  const raw = env[MANAGED_ACTION_ENV[action]];
  if (!raw?.trim()) return { configured: false, ready: false, reason: "not_configured" };
  try {
    const command = parseManagedUpdateCommand(raw)!;
    try {
      await access(command.executable, fsConstants.X_OK);
    } catch {
      return { configured: true, ready: false, label: basename(command.executable), reason: "not_executable" };
    }
    try { validateIdentityUrl(env.PIWEB_UPDATE_HEALTH_URL); }
    catch { return { configured: true, ready: false, label: basename(command.executable), reason: "health_not_configured" }; }
    if (action !== "restart" && env.PIWEB_UPDATE_PROTOCOL !== "staged-v1") {
      return { configured: true, ready: false, label: basename(command.executable), reason: "staging_not_configured" };
    }
    return { configured: true, ready: true, label: basename(command.executable) };
  } catch {
    return { configured: true, ready: false, reason: "invalid_config" };
  }
}

function defaultBackupRoot(): string {
  return join(getAgentDir(), "updates", "backups");
}

async function prepareBackupRoot(input: string, cwd: string): Promise<{ root: string; writable: boolean; freeBytes?: number }> {
  try {
    await mkdir(input, { recursive: true, mode: 0o700 });
    await chmod(input, 0o700);
    const [root, sourceRoot] = await Promise.all([realpath(input), realpath(cwd)]);
    if (pathInside(sourceRoot, root)) throw new Error("Backup root cannot be inside the application source");
    await access(root, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    const space = await statfs(root);
    return { root, writable: true, freeBytes: Number(space.bavail) * Number(space.bsize) };
  } catch {
    return { root: resolve(input), writable: false };
  }
}

async function readBackupMetadata(path: string): Promise<UpdateBackup | null> {
  try {
    const value = JSON.parse(await readFile(join(path, "metadata.json"), "utf8")) as Partial<UpdateBackup>;
    if (
      typeof value.id !== "string"
      || typeof value.createdAt !== "string"
      || typeof value.path !== "string"
      || (value.source !== "git" && value.source !== "archive")
      || typeof value.version !== "string"
      || typeof value.dirty !== "boolean"
      || typeof value.untrackedFiles !== "number"
    ) return null;
    return value as UpdateBackup;
  } catch {
    return null;
  }
}

export async function listUpdateBackups(root: string, limit = 5): Promise<UpdateBackup[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const backups = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("source-"))
      .map((entry) => readBackupMetadata(join(root, entry.name))));
    return backups
      .filter((entry): entry is UpdateBackup => Boolean(entry))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(20, limit)));
  } catch {
    return [];
  }
}

export async function getUpdateCenterStatus(options: UpdateCenterOptions = {}): Promise<UpdateCenterStatus> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const [version, checkout, release, updateAction, restartAction, rollbackAction] = await Promise.all([
    jsonVersion(cwd),
    checkoutStatus(cwd),
    latestRelease(env, options.forceReleaseRefresh),
    managedActionStatus("update", env),
    managedActionStatus("restart", env),
    managedActionStatus("rollback", env),
  ]);
  const backup = await prepareBackupRoot(options.backupRoot ?? env.PIWEB_UPDATE_BACKUP_DIR ?? defaultBackupRoot(), cwd);
  const recent = backup.writable ? await listUpdateBackups(backup.root) : [];
  const operations = await listUpdateOperations(operationRoot(env)) as UpdateCenterStatus["operations"];
  const updateAvailable = release.version ? compareCalendarVersions(version, release.version) < 0 : null;
  const checks: UpdatePreflightCheck[] = [
    { id: "node", state: isSupportedNodeVersion(process.versions.node) ? "pass" : "fail", detail: `Node ${process.versions.node} · ${NODE_SUPPORT_DESCRIPTION}` },
    {
      id: "release",
      state: release.version ? "pass" : "warning",
      detail: release.version ? `${release.tag}` : (release.error ?? "Latest release is unavailable"),
    },
    {
      id: "source",
      state: checkout.source === "git" ? "pass" : "warning",
      detail: checkout.source === "git" ? `${checkout.branch} · ${checkout.head?.slice(0, 7)}` : "Release archive",
    },
    {
      id: "backup",
      state: backup.writable && (backup.freeBytes ?? 0) >= MIN_BACKUP_BYTES ? "pass" : "fail",
      detail: backup.writable ? `${Math.round((backup.freeBytes ?? 0) / 1024 / 1024)} MB free` : "Backup directory is unavailable",
    },
    {
      id: "workspace",
      state: checkout.dirty ? "warning" : "pass",
      detail: checkout.dirty ? `${checkout.changedFiles} changed files; backup required` : "Source is clean",
    },
    {
      id: "updater",
      state: updateAction.ready ? "pass" : "warning",
      detail: updateAction.ready ? updateAction.label! : updateAction.reason!,
    },
    {
      id: "restart",
      state: restartAction.ready ? "pass" : "warning",
      detail: restartAction.ready ? restartAction.label! : restartAction.reason!,
    },
  ];
  return {
    checkedAt: new Date().toISOString(),
    running: runningIdentity(),
    operations,
    current: {
      version,
      source: checkout.source,
      head: checkout.head,
      branch: checkout.branch,
      dirty: checkout.dirty,
      changedFiles: checkout.changedFiles,
      untrackedFiles: checkout.untrackedFiles,
      sourceFingerprint: createHash("sha256").update(`${checkout.head ?? "archive"}\n${checkout.statusText}`).digest("hex"),
    },
    latest: release,
    updateAvailable,
    preflight: {
      ready: !operations?.active && checks.every((check) => check.state !== "fail") && Boolean(release.version) && updateAction.ready && restartAction.ready,
      checks,
    },
    backup: {
      ...backup,
      latest: recent[0],
      recent,
    },
    actions: {
      backup: { configured: true, ready: backup.writable, label: "built-in" },
      update: updateAction,
      restart: restartAction,
      rollback: rollbackAction,
    },
    dataImpact: {
      preservesAgentData: true,
      sourceMayChange: true,
      requiresRestart: true,
    },
    commands: {
      update: "bash setup.sh",
      restart: "npm start",
      rollback: "Restore the selected private backup, then run TGD_SETUP_OFFLINE=1 bash setup.sh",
    },
  };
}

async function copyUntrackedFile(cwd: string, destinationRoot: string, relativePath: string): Promise<boolean> {
  const source = resolve(cwd, relativePath);
  if (!pathInside(cwd, source)) return false;
  const destination = resolve(destinationRoot, relativePath);
  if (!pathInside(destinationRoot, destination)) return false;
  const info = await lstat(source);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return true;
  }
  if (!info.isFile()) return false;
  await copyFile(source, destination);
  return true;
}

async function createGitBackup(cwd: string, directory: string, checkout: CheckoutStatus): Promise<number> {
  await Promise.all([
    writeFile(join(directory, "status.txt"), `${checkout.statusText}\n`, { mode: 0o600 }),
    git(["diff", "--binary"], cwd).then((value) => writeFile(join(directory, "working-tree.patch"), `${value}\n`, { mode: 0o600 })),
    git(["diff", "--cached", "--binary"], cwd).then((value) => writeFile(join(directory, "staged.patch"), `${value}\n`, { mode: 0o600 })),
    git(["bundle", "create", join(directory, "source.bundle"), "HEAD"], cwd, 60_000).then(() => undefined),
  ]);
  const untrackedText = await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  const untracked = untrackedText.split("\0").filter(Boolean);
  const destinationRoot = join(directory, "untracked");
  let copied = 0;
  for (const path of untracked) {
    if (await copyUntrackedFile(cwd, destinationRoot, path)) copied += 1;
  }
  await writeFile(join(directory, "untracked-files.txt"), `${untracked.join("\n")}\n`, { mode: 0o600 });
  return copied;
}

async function createArchiveBackup(cwd: string, directory: string): Promise<void> {
  await execFileAsync("tar", [
    "-czf",
    join(directory, "source.tar.gz"),
    "--exclude=.git",
    "--exclude=.next",
    "--exclude=node_modules",
    ".",
  ], { cwd, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
}

export async function createUpdateBackup(options: CreateBackupOptions = {}): Promise<UpdateBackup> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const rootStatus = await prepareBackupRoot(options.backupRoot ?? process.env.PIWEB_UPDATE_BACKUP_DIR ?? defaultBackupRoot(), cwd);
  if (!rootStatus.writable) throw new Error("Private backup directory is unavailable");
  if ((rootStatus.freeBytes ?? 0) < MIN_BACKUP_BYTES) throw new Error("At least 512 MB of free space is required for a source backup");
  const checkout = await checkoutStatus(cwd);
  const version = options.version ?? await jsonVersion(cwd);
  const createdAt = new Date().toISOString();
  const id = `source-${createdAt.replace(/[-:.]/g, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
  const directory = join(rootStatus.root, id);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  let untrackedFiles = checkout.untrackedFiles;
  try {
    if (checkout.source === "git") {
      untrackedFiles = await createGitBackup(cwd, directory, checkout);
    } else {
      await createArchiveBackup(cwd, directory);
    }
    const metadata: UpdateBackup = {
      id,
      createdAt,
      path: directory,
      source: checkout.source,
      version,
      head: checkout.head,
      branch: checkout.branch,
      dirty: checkout.dirty,
      untrackedFiles,
    };
    await writeFile(join(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(directory, "RECOVERY.md"), [
      `# tGD Pi Web source backup`,
      "",
      `Created: ${createdAt}`,
      `Version: ${version}`,
      `Source: ${checkout.source}`,
      "",
      "Pi sessions, credentials, schedules, and settings live in the Pi agent data directory and are not modified by an application source update.",
      "Use this backup only after stopping the Web server. Re-run `TGD_SETUP_OFFLINE=1 bash setup.sh` after restoring source files.",
      "",
    ].join("\n"), { mode: 0o600 });
    return metadata;
  } catch (error) {
    await writeFile(join(directory, "FAILED.txt"), `${errorText(error)}\n`, { mode: 0o600 }).catch(() => undefined);
    throw error;
  }
}

export async function findUpdateBackup(root: string, id: string): Promise<UpdateBackup | null> {
  if (!/^source-[A-Za-z0-9._-]+$/.test(id)) return null;
  const candidate = resolve(root, id);
  if (!pathInside(resolve(root), candidate)) return null;
  return readBackupMetadata(candidate);
}

export function updateActionFingerprint(
  status: UpdateCenterStatus,
  action: UpdateCenterAction,
  backupId?: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    action,
    backupId: backupId ?? null,
    currentVersion: status.current.version,
    currentHead: status.current.head ?? null,
    sourceFingerprint: status.current.sourceFingerprint,
    latestTag: status.latest.tag ?? null,
  })).digest("hex");
}

export function validateUpdateAction(status: UpdateCenterStatus, action: UpdateCenterAction, backupId?: string): string | null {
  if (status.operations?.active) return "Another managed update operation is active; wait for its recorded result";
  if (action === "backup") return status.actions.backup.ready ? null : "Private backup is unavailable";
  const managed = status.actions[action];
  if (!managed.ready) return `Managed ${action} action is not configured`;
  if (action === "update" && !status.latest.tag) return "Latest release metadata is unavailable";
  if (action === "update" && status.updateAvailable !== true) return "No newer release is available";
  if (action === "rollback" && !backupId) return "Choose a recovery backup before rollback";
  return null;
}

export async function beginManagedUpdateOperation(
  action: ManagedUpdateAction,
  context: { targetTag?: string; backup?: UpdateBackup },
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateOperation> {
  if (!(await managedActionStatus(action, env)).ready) throw new Error(`Managed ${action} verification/staging contract is not configured`);
  const before = runningIdentity();
  if (!/^[a-f0-9]{40,64}$/.test(before.build.sourceSha ?? "") || before.build.dirty !== false) {
    throw new Error("Managed updates require verifiable clean running-build provenance; source archives and development builds need operator recovery");
  }
  const root = operationRoot(env);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (pathInside(await realpath(process.cwd()), await realpath(root))) throw new Error("Update operation records must be outside the application checkout");
  const expected = action === "update"
    ? { version: context.targetTag?.replace(/^v/, "") }
    : action === "rollback"
      ? { version: context.backup?.version, sourceSha: context.backup?.head }
      : { version: before.build.version, sourceSha: before.build.sourceSha };
  if (!/^\d{4}\.\d{2}\.\d{2}(?:-[1-9]\d*)?$/.test(expected.version ?? "")
    || (action !== "update" && !/^[a-f0-9]{40,64}$/.test(expected.sourceSha ?? ""))
    || (action === "rollback" && context.backup?.dirty)) {
    throw new Error("Managed action requires an exact clean target; review changed/archive backups manually");
  }
  return await reserveUpdateOperation(root, { action, cwd: process.cwd(), before, expected }) as UpdateOperation;
}

export async function failReservedUpdateOperation(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const root = operationRoot(env);
  const operation = await readUpdateOperation(root, id);
  if (operation.status === "reserved") await finishUpdateOperation(root, id, "failed", "Update could not start; no verified update was recorded");
}

export async function executeManagedUpdateAction(
  action: ManagedUpdateAction,
  context: { targetTag?: string; backup?: UpdateBackup; operationId?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ pid: number; label: string; operationId: string }> {
  const command = parseManagedUpdateCommand(env[MANAGED_ACTION_ENV[action]]);
  if (!command) throw new Error(`Managed ${action} action is not configured`);
  await access(command.executable, fsConstants.X_OK);
  const root = operationRoot(env);
  const operation = context.operationId ? await readUpdateOperation(root, context.operationId)
    : await beginManagedUpdateOperation(action, context, env);
  if (operation.action !== action || operation.status !== "reserved" || operation.cwd !== process.cwd()) throw new Error("Update reservation no longer matches this action");
  const cookie = gateEnabled() ? `${AUTH_COOKIE}=${await issueAccessToken()}` : "";
  const child = spawn(process.execPath, [join(process.cwd(), "scripts", "managed-update-runner.mjs")], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    shell: false,
    env: {
      ...env,
      PIWEB_UPDATE_ACTION: action,
      PIWEB_UPDATE_TARGET_TAG: context.targetTag ?? "",
      PIWEB_UPDATE_BACKUP_ID: context.backup?.id ?? "",
      PIWEB_UPDATE_BACKUP_PATH: context.backup?.path ?? "",
      PIWEB_UPDATE_OPERATION_ROOT: root,
      PIWEB_UPDATE_OPERATION_ID: operation.id,
      PIWEB_MANAGED_OPERATION_COMMAND: JSON.stringify(command),
      PIWEB_UPDATE_HEALTH_COOKIE: cookie,
    },
  });
  try {
    await new Promise<void>((resolveStarted, reject) => {
      child.once("spawn", resolveStarted);
      child.once("error", reject);
    });
    child.once("exit", () => { void failReservedUpdateOperation(operation.id, env).catch(() => {}); });
    child.unref();
    if (!child.pid) throw new Error(`Managed ${action} action did not start`);
    return { pid: child.pid, label: basename(command.executable), operationId: operation.id };
  } catch (error) {
    await failReservedUpdateOperation(operation.id, env);
    throw error;
  }
}

export function resetUpdateCenterCacheForTests(): void {
  globalThis.__piWebLatestReleaseCache = undefined;
}
