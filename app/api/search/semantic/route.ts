import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { getAllowedRoots } from "@/lib/file-security";
import { getSessionEntries, listAllSessions, resolveSessionPath } from "@/lib/session-reader";
import { readTgdArtifacts } from "@/lib/tgd-artifacts";
import { rankSemanticDocuments, type SemanticDocument } from "@/lib/semantic-search";

export const dynamic = "force-dynamic";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".md", ".css", ".scss", ".html", ".json", ".yml", ".yaml"]);
const SKIP = new Set([".git", ".next", "node_modules", "dist", "build", "coverage"]);

function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => typeof block?.text === "string" ? block.text : "").join("\n");
}

async function sessionDocuments(cwd: string | null): Promise<SemanticDocument[]> {
  const sessions = (await listAllSessions()).filter((session) => !cwd || session.cwd === cwd).slice(0, 120);
  return (await Promise.all(sessions.map(async (session) => {
    const path = await resolveSessionPath(session.id);
    if (!path) return null;
    try {
      const text = getSessionEntries(path).filter((entry) => entry.type === "message").map((entry) => messageText((entry as { message?: unknown }).message)).filter(Boolean).join("\n").slice(0, 80_000);
      return { id: `session:${session.id}`, source: "session" as const, title: session.name || session.firstMessage || session.id.slice(0, 8), text, sessionId: session.id, modified: session.modified };
    } catch { return null; }
  }))).filter((document): document is NonNullable<typeof document> => Boolean(document));
}

async function artifactDocuments(cwd: string): Promise<SemanticDocument[]> {
  const artifacts = readTgdArtifacts(cwd);
  const files = [...artifacts.top, ...artifacts.features.flatMap((feature) => [...feature.docs, ...feature.prototypes])];
  return (await Promise.all(files.map(async (file) => {
    try { return { id: `artifact:${file.path}`, source: "artifact" as const, title: file.name, path: file.path, text: (await readFile(file.path, "utf8")).slice(0, 80_000) }; }
    catch { return null; }
  }))).filter((document): document is NonNullable<typeof document> => Boolean(document));
}

async function codeDocuments(cwd: string): Promise<SemanticDocument[]> {
  const documents: SemanticDocument[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  for (let index = 0; index < queue.length && documents.length < 260; index++) {
    const { dir, depth } = queue[index];
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 7) queue.push({ dir: full, depth: depth + 1 });
      else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) {
        try { documents.push({ id: `code:${full}`, source: "code", title: entry.name, path: full, text: (await readFile(full, "utf8")).slice(0, 48_000) }); } catch { /* unreadable */ }
      }
      if (documents.length >= 260) break;
    }
  }
  return documents;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const cwdParam = url.searchParams.get("cwd")?.trim() || null;
  if (query.length < 2) return Response.json({ hits: [], mode: "hybrid-local" });
  let cwd: string | null = null;
  if (cwdParam) {
    cwd = resolve(cwdParam);
    const roots = await getAllowedRoots();
    if (![...roots].some((root) => cwd === root || cwd!.startsWith(root + sep))) return Response.json({ error: "cwd not allowed" }, { status: 403 });
  }
  const documents = [
    ...await sessionDocuments(cwd),
    ...(cwd ? await artifactDocuments(cwd) : []),
    ...(cwd ? await codeDocuments(cwd) : []),
  ];
  return Response.json({ hits: rankSemanticDocuments(query, documents), mode: "hybrid-local", indexed: documents.length }, { headers: { "Cache-Control": "no-store" } });
}
