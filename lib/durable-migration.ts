import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { createDurableChat, type DurableChatOptions } from "./durable-chat";
import { durableEntries, durableSessionDirectory, isDurableSessionId } from "./durable-session-store";
import { LEGACY_CONTEXT, legacyContext, legacyModel, legacySettings, parseLegacyArchive, plain } from "./durable-legacy";
import { getRpcSession, isRpcSessionStarting } from "./rpc-manager";
import { readAgentRunStore } from "./agent-run-store";
import { readScheduleStore } from "./schedule-store";
import { listAllSessions, resolveSessionPath } from "./session-reader";
import { isStandardSession, migrationDirectory, migrationKey, publishSessionMigration, resolveMigratedSessionId } from "./session-migrations";

export interface MigrationResult { sessionId: string; sourceId: string; status: "converted" | "unchanged" | "deferred"; reason?: string }
declare global { var __piSessionMigrations: Map<string, Promise<MigrationResult>> | undefined; }
const pending = () => globalThis.__piSessionMigrations ??= new Map();
const key = (id: string) => join(migrationDirectory(), migrationKey(id));
export async function waitForSessionMigration(id: string): Promise<string> {
  await pending().get(key(id)); return resolveMigratedSessionId(id);
}
/** Only an explicit continuation admits migration. Lists and history reads stay read-only. */
export async function migrateLegacySession(id: string, options: Partial<DurableChatOptions> = {}): Promise<MigrationResult> {
  const canonical = resolveMigratedSessionId(id);
  if (canonical !== id) return { sessionId: canonical, sourceId: id, status: "converted" };
  if (isDurableSessionId(id) || isStandardSession(id)) return { sessionId: id, sourceId: id, status: "unchanged" };
  const existing = pending().get(key(id)); if (existing) return existing;
  const task = migrate(id, options); pending().set(key(id), task);
  try { return await task; } finally { pending().delete(key(id)); }
}
async function migrate(id: string, options: Partial<DurableChatOptions>): Promise<MigrationResult> {
  const deferred = (reason: string): MigrationResult => ({ sessionId: id, sourceId: id, status: "deferred", reason });
  if (isRpcSessionStarting(id)) return deferred("The conversation is still opening; conversion will be retried when idle.");
  const owned = [...readAgentRunStore().runs, ...readScheduleStore().runs].some(run => run.sessionId === id && ["queued", "running", "waiting_for_input"].includes(run.status));
  if (owned) return deferred("A background task still owns this conversation; conversion will be retried after it finishes.");
  const live = getRpcSession(id);
  const busy = live?.migrationBusyReason(); if (busy) return deferred(busy);
  let unfreeze: (() => void) | undefined;
  let unlock: (() => Promise<void>) | undefined;
  let candidate: Awaited<ReturnType<typeof createDurableChat>> | undefined;
  let candidateDirectory: string | undefined;
  let published = false;
  try {
    unfreeze = live?.reserveMigration();
    const sourcePath = await resolveSessionPath(id);
    if (!sourcePath) return { sessionId: id, sourceId: id, status: "unchanged" };
    mkdirSync(migrationDirectory(), { recursive: true, mode: 0o700 });
    const slot = key(id);
    writeFileSync(slot, "", { flag: "a", mode: 0o600 });
    unlock = await lockfile.lock(slot, { stale: 10_000, update: 5_000, retries: 0 });
    const canonical = resolveMigratedSessionId(id);
    if (canonical !== id) return { sessionId: canonical, sourceId: id, status: "converted" };
    const source = readFileSync(sourcePath, "utf8");
    const digest = createHash("sha256").update(source).digest("hex");
    const archive = parseLegacyArchive(source, id, live?.inner.sessionManager.getLeafId());
    if (!archive.entries.some(entry => entry.type === "message")) return { sessionId: id, sourceId: id, status: "unchanged" };
    if (live && JSON.stringify(plain(live.inner.sessionManager.getEntries())) !== JSON.stringify(archive.entries)) throw new Error("The live conversation has unsaved changes; conversion will be retried later");
    const info = (await listAllSessions()).find(session => session.id === id);
    const selected = legacyContext(archive);
    const settings = legacySettings(archive);
    const model = live?.inner.model ? { provider: live.inner.model.provider, modelId: live.inner.model.id } : selected.model;
    const group = randomUUID();
    candidateDirectory = durableSessionDirectory(group);
    candidate = await createDurableChat({ ...options, cwd: archive.header.cwd, group, directory: candidateDirectory,
      provider: model?.provider ?? options.provider, modelId: model?.modelId ?? options.modelId,
      thinkingLevel: live?.inner.agent?.state?.thinkingLevel ?? selected.thinkingLevel,
      toolNames: live?.inner.getActiveToolNames() ?? settings.toolNames,
      settings: live ? { ...options.settings, compaction: { enabled: live.inner.autoCompactionEnabled }, retry: { enabled: live.inner.autoRetryEnabled } } : options.settings,
      legacy: { archive, sourceId: id, name: info?.name, parentSessionId: info?.parentSessionId, instructions: live?.inner.systemPrompt ?? settings.instructions },
    });
    const projection = candidate.getProjection();
    const seed = projection.entries.find(entry => entry.kind === LEGACY_CONTEXT);
    const state = candidate.getState();
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount || projection.entries.some(entry => entry.kind === "pi.user" || entry.kind === "pi.assistant")) throw new Error("An extension started work during conversion; retained Standard mode");
    if (!seed || JSON.stringify(seed.data) !== JSON.stringify(archive) || JSON.stringify(seed.model) !== JSON.stringify(legacyModel(archive))) throw new Error("Imported history verification failed");
    const restored = durableEntries(projection.entries, projection.info.created);
    if (archive.entries.some(entry => !restored.some(saved => saved.id === entry.id))) throw new Error("Imported branch verification failed");
    if (readFileSync(sourcePath, "utf8") !== source) throw new Error("The original conversation changed during conversion; retained Standard mode");
    // Publication is the only cutover. No scheduler/model task has run before it.
    publishSessionMigration({ version: 1, sourceId: id, sessionId: candidate.sessionId, sourcePath, sourceHash: digest, migratedAt: new Date().toISOString() });
    published = true;
    candidate.activateMigration();
    live?.completeMigration(candidate);
    return { sessionId: candidate.sessionId, sourceId: id, status: "converted" };
  } catch (error) {
    if (published) throw error;
    await candidate?.close().catch(() => {});
    if (candidateDirectory) rmSync(candidateDirectory, { recursive: true, force: true });
    return deferred(error instanceof Error ? error.message : "Conversion could not be verified; retained Standard mode");
  } finally { unfreeze?.(); await unlock?.(); }
}
