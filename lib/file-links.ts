// ============================================================================

import type { FileOpenMode, FileOpenOrigin } from "@/lib/file-open";
// Clickable file paths in chat messages.
//
// `looksLikeFilePath` is the conservative heuristic that decides whether a
// piece of inline code is a file reference. `requestOpenFile` broadcasts a
// click to whoever owns the file viewer (AppShell) — MarkdownBody sits many
// component layers below it, so a tiny event bus beats prop-threading.
// ============================================================================

export interface FileLink {
  /** Path as written (may be relative to the session cwd). */
  path: string;
  /** Optional line from a `:N` suffix. */
  line?: number;
  mode?: FileOpenMode;
  /** Project of the message that produced this link, including parallel panes. */
  cwd?: string;
  /** Optional return path when the link came from a message or search result. */
  origin?: FileOpenOrigin;
}

// Bare filenames (no slash) must carry a recognizable extension, otherwise
// prose like `object.property` would light up as a link.
const KNOWN_EXT = /\.(tsx?|jsx?|mjs|cjs|json|jsonc|md|markdown|mdx|css|scss|less|html?|py|pyi|rs|go|java|rb|sh|bash|zsh|fish|yml|yaml|toml|txt|log|sql|c|h|cpp|hpp|cc|hh|cxx|vue|svelte|astro|lock|env|cfg|conf|ini|xml|csv|tsv|svg|png|jpe?g|gif|webp|ico|pdf|docx?|xlsx?|proto|graphql|prisma|swift|kt|kts|php|pl|lua|r|scala|clj|cljs|ex|exs|erl|hs|elm|ml|mli|vb|cs|fs|fsx|dart|sol|zig|nim|tf|hcl|dockerfile|makefile|gradle|properties)$/i;

// Extension-less names that are unambiguously files, not prose.
const KNOWN_BARE = /^(makefile|gnumakefile|dockerfile|containerfile|justfile|gemfile|rakefile|procfile|vagrantfile|brewfile)$/i;

const isFileName = (seg: string) => KNOWN_EXT.test(seg) || KNOWN_BARE.test(seg);

/**
 * Does this inline-code text look like a file path?
 * - `name.ext` (known extension), `src/foo.ts`, `./x`, `../x`, `/abs/path`, `~/x`
 * - optional `:line` / `:line:col` suffix
 * - conservative on purpose: no spaces, no URL schemes, prose-ish text stays text
 */
export function looksLikeFilePath(text: string): FileLink | null {
  if (!text || text.length > 260 || /\s/.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null; // URLs
  const m = text.match(/^(.*?):(\d+)(?::\d+)?$/);
  const base = m ? m[1] : text;
  const line = m ? parseInt(m[2], 10) : undefined;
  if (!/^[\w.@~/-]+$/.test(base)) return null;
  if (base.endsWith("/") || base === "." || base === "..") return null;
  const lastSeg = base.split("/").pop() ?? "";
  if (!base.includes("/")) {
    return isFileName(lastSeg) ? { path: base, line } : null;
  }
  // With a slash: explicit prefixes always qualify; otherwise the last
  // segment needs an extension (`and/or`, `either/or` stay prose).
  if (/^(\.{1,2}\/|\/|~\/)/.test(base)) return { path: base, line };
  return isFileName(lastSeg) ? { path: base, line } : null;
}

/** Explicit Markdown destinations can contain spaces and Unicode, unlike code heuristics. */
export function parseMarkdownFileLink(href: string | undefined, sourceFilePath?: string): FileLink | null {
  if (!href || href.length > 4096 || /^(?:\/\/|#|\?)/.test(href)) return null;
  let path = href;
  if (/^file:\/\//i.test(path)) {
    // Only local file URLs; never interpret a remote file host as a local path.
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = url.pathname + url.hash;
    } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[^/]+:\d+(?::\d+)?$/.test(path)) {
    return null;
  }
  // Separate fragments before decoding so a literal %23 remains part of a filename.
  const [destination, fragment] = path.split("#", 2);
  if (destination.includes("?")) return null;
  try { path = decodeURIComponent(destination); } catch { return null; }
  if (/[\u0000-\u001f\u007f]/.test(path) || path.startsWith("//")) return null;
  const suffix = path.match(/:(\d+)(?::\d+)?$/);
  if (suffix) path = path.slice(0, -suffix[0].length);
  // Reject encoded schemes too. A colon otherwise is not a supported file separator.
  if (path.includes(":")) return null;
  const lineMatch = fragment?.match(/^L?(\d+)(?:-L?\d+)?$/);
  const number = Number(lineMatch?.[1] ?? suffix?.[1]);
  const line = Number.isSafeInteger(number) && number > 0 ? number : undefined;
  const last = path.split("/").pop() ?? "";
  if (!last || last === "." || last === "..") return null;
  if (!/^(?:\/|~\/|\.{1,2}\/)/.test(path) && !isFileName(last)) return null;
  if (sourceFilePath && !/^(?:\/|~\/)/.test(path)) {
    const parts = sourceFilePath.replace(/\\/g, "/").split("/");
    parts.pop();
    for (const part of path.split("/")) {
      if (part === "..") { if (parts.length > 1) parts.pop(); }
      else if (part && part !== ".") parts.push(part);
    }
    path = parts.join("/");
  }
  return { path, line, ...(!line && /\.html?$/i.test(path) ? { mode: "preview" as const } : {}) };
}

const EVENT = "pi-open-file-link";

/** Fired by MarkdownBody when a file-path inline code is clicked. */
export function requestOpenFile(link: FileLink, element?: HTMLElement): void {
  const scope = element?.closest<HTMLElement>("[data-chat-cwd]");
  const entryId = element?.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
  const origin = link.origin ?? (entryId ? { kind: "message" as const, entryId } : undefined);
  const detail: FileLink = {
    ...link,
    cwd: link.cwd ?? scope?.dataset.chatCwd,
    origin: origin?.kind === "message"
      ? { ...origin, sessionId: origin.sessionId ?? scope?.dataset.chatSessionId }
      : origin,
  };
  window.dispatchEvent(new CustomEvent<FileLink>(EVENT, { detail }));
}

/** AppShell subscribes here and resolves/validates/opens the file. */
export function onOpenFileRequest(handler: (link: FileLink) => void): () => void {
  const fn = (e: Event) => handler((e as CustomEvent<FileLink>).detail);
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
