import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { FileOperationError, readFileSnapshot, replaceFileSnapshot, withFileMutation, type FileSnapshot } from "./versioned-file";

export const MAX_MODELS_CONFIG_BYTES = 4 * 1024 * 1024;
const FILENAME = "models.json";
type JsonObject = Record<string, unknown>;
export interface ModelsConfiguration extends JsonObject { providers: Record<string, JsonObject> }
export interface ModelsConfigSnapshot { config: ModelsConfiguration; revision: string; path: string }
export class ModelsConfigError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: "save_outcome_unknown") { super(message); }
}
function invalid(): never { throw new ModelsConfigError("Invalid models configuration; check provider and model field types and limits"); }
function object(value: unknown): asserts value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
}
function boundedJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 100_000 || depth > 20) invalid();
  if (typeof value === "string") { if (value.length > 65_536 || value.includes("\0")) invalid(); return; }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid(); return; }
  if (Array.isArray(value)) {
    if (value.length > 4_096) invalid();
    for (const child of value) boundedJson(child, depth + 1, budget);
    return;
  }
  object(value);
  const entries = Object.entries(value);
  if (entries.length > 4_096) invalid();
  for (const [key, child] of entries) {
    if (key.length > 1_024 || key.includes("\0") || ["__proto__", "constructor", "prototype"].includes(key)) invalid();
    boundedJson(child, depth + 1, budget);
  }
}
function strings(value: JsonObject, fields: string[], max = 8_192): void {
  for (const field of fields) if (value[field] !== undefined && (typeof value[field] !== "string" || !value[field].length || value[field].length > max)) invalid();
}
function booleans(value: JsonObject, fields: string[]): void {
  for (const field of fields) if (value[field] !== undefined && typeof value[field] !== "boolean") invalid();
}
function headers(value: unknown): void {
  if (value === undefined) return;
  object(value);
  if (Object.keys(value).length > 128) invalid();
  for (const [name, entry] of Object.entries(value)) {
    if (!name || /[\r\n\0]/.test(name) || typeof entry !== "string" || entry.length > 65_536 || /[\r\n\0]/.test(entry)) invalid();
  }
}
function cost(value: unknown, requiredRates = false, tier = false): void {
  if (value === undefined) return;
  object(value);
  for (const field of ["input", "output", "cacheRead", "cacheWrite", ...(tier ? ["inputTokensAbove"] : [])]) {
    if (requiredRates && value[field] === undefined) invalid();
    if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0)) invalid();
  }
  if (value.tiers !== undefined) {
    if (tier || !Array.isArray(value.tiers) || value.tiers.length > 128) invalid();
    for (const entry of value.tiers) cost(entry, true, true);
  }
}
function compat(value: unknown): void {
  if (value === undefined) return;
  object(value);
  // Preserve bounded future adapter fields without narrowing custom API ids.
  booleans(value, ["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming", "supportsFinishReason", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText", "requiresReasoningContentOnAssistantMessages", "supportsOpenAIGrammarTools", "supportsStrictMode", "sendSessionAffinityHeaders", "supportsLongCacheRetention", "supportsAdditionalTools", "supportsToolSearch", "supportsEagerToolInputStreaming", "supportsCacheControlOnTools", "supportsTemperature", "forceAdaptiveThinking", "allowEmptySignature", "supportsStrictTools", "supportsToolReferences"]);
  strings(value, ["maxTokensField", "thinkingFormat", "cacheControlFormat", "deferredToolsMode", "sessionAffinityFormat"]);
  for (const field of ["chatTemplateKwargs", "chatTemplateArgs", "openRouterRouting", "vercelGatewayRouting"]) if (value[field] !== undefined) object(value[field]);
}
function model(value: unknown, override = false): void {
  object(value);
  if (!override && (typeof value.id !== "string" || !value.id.trim())) invalid();
  strings(value, ["id", "name", "api", "baseUrl"]);
  booleans(value, ["reasoning"]);
  for (const field of ["contextWindow", "maxTokens"]) {
    if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]) || value[field] <= 0)) invalid();
  }
  if (value.input !== undefined && (!Array.isArray(value.input) || value.input.some(entry => entry !== "text" && entry !== "image"))) invalid();
  if (value.thinkingLevelMap !== undefined) {
    object(value.thinkingLevelMap);
    for (const entry of Object.values(value.thinkingLevelMap)) if (entry !== null && typeof entry !== "string") invalid();
  }
  if (value.samplingParams !== undefined) object(value.samplingParams);
  headers(value.headers); cost(value.cost, !override); compat(value.compat);
}

/** Validate, never coerce/drop fields. Unknown bounded metadata survives edits. */
export function validateModelsConfig(value: unknown): ModelsConfiguration {
  boundedJson(value);
  object(value);
  object(value.providers);
  if (Object.keys(value.providers).length > 128) invalid();
  for (const [name, provider] of Object.entries(value.providers)) {
    if (!name.trim() || name.length > 256) invalid();
    object(provider);
    strings(provider, ["name", "baseUrl", "api"]);
    strings(provider, ["apiKey"], 65_536);
    booleans(provider, ["authHeader"]);
    if (provider.oauth !== undefined && provider.oauth !== "radius") invalid();
    headers(provider.headers); compat(provider.compat);
    if (provider.models !== undefined) {
      if (!Array.isArray(provider.models)) invalid();
      const ids = new Set<string>();
      for (const entry of provider.models) {
        model(entry);
        const id = (entry as JsonObject).id as string;
        if (ids.has(id)) invalid();
        ids.add(id);
      }
    }
    if (provider.modelOverrides !== undefined) {
      object(provider.modelOverrides);
      for (const [id, entry] of Object.entries(provider.modelOverrides)) { if (!id.trim()) invalid(); model(entry, true); }
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_MODELS_CONFIG_BYTES) throw new ModelsConfigError("Models configuration is too large", 413);
  return value as ModelsConfiguration;
}

/** Pi accepts BOM and JSON comments. Keep comment markers inside strings. */
function stripComments(text: string): string {
  let result = "", quoted = false, escaped = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; result += char; }
    else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
      result += text[i] ?? "";
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      if (i >= text.length) throw new Error("Unclosed comment");
      i++; result += " ";
    } else result += char;
  }
  return result;
}
function parse(snapshot: FileSnapshot): ModelsConfiguration {
  if (!snapshot.exists) return { providers: {} };
  try { return validateModelsConfig(JSON.parse(stripComments(snapshot.text))); }
  catch { throw new ModelsConfigError("Models configuration cannot be read: invalid JSON, schema or size. No changes were made", 503); }
}
function safeError(error: unknown): never {
  if (error instanceof ModelsConfigError) throw error;
  if (error instanceof FileOperationError) throw new ModelsConfigError(error.message, error.status);
  throw new ModelsConfigError("Models configuration could not be accessed safely; no changes were made", 503);
}
export function modelsConfigBackupDirectory(): string { return join(getAgentDir(), "models-config-backups"); }
export function modelsConfigPath(): string { return resolve(getAgentDir(), FILENAME); }
export async function readModelsConfig(): Promise<ModelsConfigSnapshot> {
  const path = modelsConfigPath();
  try {
    try { await fs.lstat(getAgentDir()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: { providers: {} }, revision: "missing", path };
      throw error;
    }
    const snapshot = await readFileSnapshot(getAgentDir(), FILENAME, MAX_MODELS_CONFIG_BYTES);
    return { config: parse(snapshot), revision: snapshot.version, path };
  } catch (error) { safeError(error); }
}
async function backupSnapshot(snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.exists) return;
  const directory = modelsConfigBackupDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = await fs.lstat(directory);
  if (!identity.isDirectory() || identity.isSymbolicLink() || (process.platform !== "win32" && (identity.mode & 0o077) !== 0)) {
    throw new ModelsConfigError("Private models backup directory is unavailable; no changes were made", 503);
  }
  const canonical = await fs.realpath(directory);
  const id = randomUUID();
  const temporary = join(canonical, `.models-${id}.tmp`);
  const target = join(canonical, `models-${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.json`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(snapshot.text, "utf8"); await handle.sync();
    const current = await fs.lstat(directory);
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.isSymbolicLink()) throw new ModelsConfigError("Private models backup directory changed; no changes were made", 409);
    await fs.rename(temporary, target);
  } finally { await handle.close(); await fs.unlink(temporary).catch(() => {}); }
}
export async function saveModelsConfig(value: unknown, revision?: string): Promise<ModelsConfigSnapshot> {
  if (!revision) throw new ModelsConfigError("A models configuration revision is required; reload before saving", 428);
  const config = validateModelsConfig(value);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_MODELS_CONFIG_BYTES) throw new ModelsConfigError("Models configuration is too large", 413);
  let committed = false;
  try {
    const root = getAgentDir();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return await withFileMutation(root, FILENAME, async () => {
      const snapshot = await readFileSnapshot(root, FILENAME, MAX_MODELS_CONFIG_BYTES);
      parse(snapshot);
      if (revision !== snapshot.version) throw new ModelsConfigError("Models configuration changed. Your draft was not saved; reload before saving", 409);
      await backupSnapshot(snapshot);
      await replaceFileSnapshot(root, FILENAME, { ...snapshot, mode: 0o600 }, text, MAX_MODELS_CONFIG_BYTES);
      // replaceFileSnapshot returns after the atomic rename; its temporary
      // cleanup is best-effort. Subsequent readback OR lock-close errors must
      // not claim that the now-committed configuration was left unchanged.
      committed = true;
      const saved = await readFileSnapshot(root, FILENAME, MAX_MODELS_CONFIG_BYTES);
      return { config: JSON.parse(text) as ModelsConfiguration, revision: saved.version, path: resolve(root, FILENAME) };
    });
  } catch (error) {
    if (committed) throw new ModelsConfigError("Models configuration saving may have completed; reload before trying again", 503, "save_outcome_unknown");
    safeError(error);
  }
}
