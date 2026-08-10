import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { isPathAllowed, isWindowsAbsolutePath } from "./file-security";

const MAX_SESSION_IMPORT_BYTES = 25 * 1024 * 1024;

export class SessionImportValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SessionImportValidationError";
  }
}

export interface SessionImportPreview {
  sourcePath: string;
  fileName: string;
  sessionId: string;
  cwd: string;
  headerCwd: string;
  created?: string;
  name?: string;
  messageCount: number;
  size: number;
  destinationPath: string;
}

async function canonicalRoots(roots: Set<string>): Promise<Set<string>> {
  const canonical = await Promise.all([...roots].map(async (root) => {
    try {
      return await realpath(root);
    } catch {
      return path.resolve(root);
    }
  }));
  return new Set(canonical);
}

function absolutePath(input: string, label: string): string {
  const value = input.trim();
  if (!value || value.includes("\0")) throw new SessionImportValidationError(`${label} is required`);
  if (!path.isAbsolute(value) && !isWindowsAbsolutePath(value)) {
    throw new SessionImportValidationError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

async function requireAllowedDirectory(input: string, roots: Set<string>): Promise<string> {
  const resolved = absolutePath(input, "CWD override");
  let canonical: string;
  try {
    canonical = await realpath(resolved);
    const stats = await stat(canonical);
    if (!stats.isDirectory()) throw new SessionImportValidationError("CWD override must be a directory");
  } catch (error) {
    if (error instanceof SessionImportValidationError) throw error;
    throw new SessionImportValidationError("CWD override does not exist");
  }
  if (!isPathAllowed(canonical, roots)) {
    throw new SessionImportValidationError("CWD override is outside the allowed project roots", 403);
  }
  return canonical;
}

export async function inspectSessionImport(
  inputPath: string,
  allowedRoots: Set<string>,
  destinationDir: string,
  cwdOverride?: string,
): Promise<SessionImportPreview> {
  const requested = absolutePath(inputPath, "Session file path");
  if (path.extname(requested).toLowerCase() !== ".jsonl") {
    throw new SessionImportValidationError("Session file must use the .jsonl extension");
  }

  const roots = await canonicalRoots(allowedRoots);
  let sourcePath: string;
  let stats;
  try {
    sourcePath = await realpath(requested);
    stats = await stat(sourcePath);
  } catch {
    throw new SessionImportValidationError("Session file does not exist", 404);
  }
  if (!stats.isFile()) throw new SessionImportValidationError("Session import source must be a regular file");
  if (stats.size === 0) throw new SessionImportValidationError("Session file is empty");
  if (stats.size > MAX_SESSION_IMPORT_BYTES) {
    throw new SessionImportValidationError("Session file exceeds the 25 MB import limit", 413);
  }
  if (!isPathAllowed(sourcePath, roots)) {
    throw new SessionImportValidationError("Session file is outside the allowed project roots", 403);
  }

  let entries: Array<Record<string, unknown>>;
  try {
    entries = parseSessionEntries(await readFile(sourcePath, "utf8")) as unknown as Array<Record<string, unknown>>;
  } catch {
    throw new SessionImportValidationError("Session file is not valid JSONL");
  }
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
    throw new SessionImportValidationError("Session file is missing a valid Pi session header");
  }

  const headerCwd = header.cwd;
  const cwd = cwdOverride
    ? await requireAllowedDirectory(cwdOverride, roots)
    : await requireAllowedDirectory(headerCwd, roots).catch((error) => {
      if (error instanceof SessionImportValidationError) {
        throw new SessionImportValidationError(
          "The session CWD is unavailable or untrusted; provide an allowed CWD override",
          error.status,
        );
      }
      throw error;
    });

  const fileName = path.basename(sourcePath);
  const destinationPath = path.join(destinationDir, fileName);
  if (path.resolve(destinationPath) !== path.resolve(sourcePath)) {
    try {
      await access(destinationPath);
      throw new SessionImportValidationError(
        `A session file named ${fileName} already exists in the destination`,
        409,
      );
    } catch (error) {
      if (error instanceof SessionImportValidationError) throw error;
    }
  }

  let name: string | undefined;
  let messageCount = 0;
  for (const entry of entries.slice(1)) {
    if (entry.type === "message") messageCount++;
    if (entry.type === "session_info") {
      const nextName = typeof entry.name === "string" ? entry.name.trim() : "";
      name = nextName || undefined;
    }
  }

  return {
    sourcePath,
    fileName,
    sessionId: header.id,
    cwd,
    headerCwd,
    ...(typeof header.timestamp === "string" ? { created: header.timestamp } : {}),
    ...(name ? { name } : {}),
    messageCount,
    size: stats.size,
    destinationPath,
  };
}
