import { realpath } from "node:fs/promises";
import { extname } from "node:path";
import { readSearchFile, resolveSearchRoot, walkSearchFiles } from "@/lib/search-files";
import { trimToUtf8Boundary } from "@/lib/text-prefix";
import { getAllowedRoots } from "@/lib/file-security";
import { getSessionEntries, listAllSessions, resolveSessionPath } from "@/lib/session-reader";
import { readTgdArtifacts } from "@/lib/tgd-artifacts";
import { rankSemanticDocuments, type SemanticDocument } from "@/lib/semantic-search";
import { durableEntries, isDurableSessionId, readDurableProjection } from "@/lib/durable-session-store";

export const dynamic = "force-dynamic";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".md", ".css", ".scss", ".html", ".json", ".yml", ".yaml"]);

function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => typeof block?.text === "string" ? block.text : "").join("\n");
}

async function sessionDocuments(cwd: string | null): Promise<SemanticDocument[]> {
  const sessions = (await listAllSessions()).filter((session) => !cwd || session.cwd === cwd).slice(0, 120);
  return (await Promise.all(sessions.map(async (session) => {
    const projection = isDurableSessionId(session.id) ? readDurableProjection(session.id) : undefined;
    const path = isDurableSessionId(session.id) ? null : await resolveSessionPath(session.id);
    if (!projection && !path) return null;
    try {
      const entries = projection ? durableEntries(projection.entries, projection.info.created) : getSessionEntries(path!);
      const text = entries.filter((entry) => entry.type === "message").map((entry) => messageText((entry as { message?: unknown }).message)).filter(Boolean).join("\n").slice(0, 80_000);
      return { id: `session:${session.id}`, source: "session" as const, title: session.name || session.firstMessage || session.id.slice(0, 8), text, sessionId: session.id, modified: session.modified };
    } catch { return null; }
  }))).filter((document): document is NonNullable<typeof document> => Boolean(document));
}

async function artifactDocuments(cwd: string, roots: Set<string>, signal: AbortSignal): Promise<SemanticDocument[]> {
  const artifacts = readTgdArtifacts(cwd);
  if (!artifacts.tgdDir) return [];
  const root = await resolveSearchRoot(artifacts.tgdDir, roots);
  if (!root) return [];
  const files = [...artifacts.top, ...artifacts.features.flatMap(feature => [...feature.docs, ...feature.prototypes])].slice(0, 260);
  const documents: SemanticDocument[] = [];
  for (const file of files) {
    signal.throwIfAborted();
    try {
      const bytes = await readSearchFile(file.path, 80_000, { root, prefix: true });
      if (bytes) documents.push({ id: `artifact:${file.path}`, source: "artifact", title: file.name, path: file.path, text: trimToUtf8Boundary(bytes).toString("utf8") });
    } catch { /* changed, outside root, or unreadable */ }
  }
  return documents;
}

async function codeDocuments(cwd: string, signal: AbortSignal): Promise<SemanticDocument[]> {
  const { entries } = await walkSearchFiles(cwd, { signal, maxDepth: 7 });
  const documents: SemanticDocument[] = [];
  for (const entry of entries) {
    signal.throwIfAborted();
    if (entry.isDir || !CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    try {
      const bytes = await readSearchFile(entry.full, 48_000, { root: cwd, prefix: true });
      if (bytes) documents.push({ id: `code:${entry.full}`, source: "code", title: entry.name, path: entry.full, text: trimToUtf8Boundary(bytes).toString("utf8") });
    } catch { /* changed, outside root, or unreadable */ }
    if (documents.length >= 260) break;
  }
  return documents;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const cwdParam = url.searchParams.get("cwd")?.trim() || null;
  if (query.length < 2) return Response.json({ hits: [], mode: "hybrid-local" });
  try {
    let cwd: string | null = null;
    const roots = await getAllowedRoots();
    if (cwdParam) {
      const permitted = await resolveSearchRoot(cwdParam, roots);
      if (!permitted) return Response.json({ error: "cwd not allowed" }, { status: 403 });
      cwd = await realpath(permitted);
    }
    request.signal.throwIfAborted();
    const groups = await Promise.all([
      sessionDocuments(cwdParam ? cwdParam : null),
      cwd ? artifactDocuments(cwd, roots, request.signal) : [],
      cwd ? codeDocuments(cwd, request.signal) : [],
    ]);
    request.signal.throwIfAborted();
    const documents = groups.flat();
    return Response.json({ hits: rankSemanticDocuments(query, documents), mode: "hybrid-local", indexed: documents.length }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: request.signal.aborted ? "Search cancelled" : "Search failed" }, { status: request.signal.aborted ? 499 : 500 });
  }
}
