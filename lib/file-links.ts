// ============================================================================

import type { FileOpenOrigin } from "@/lib/file-open";
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

const EVENT = "pi-open-file-link";

/** Fired by MarkdownBody when a file-path inline code is clicked. */
export function requestOpenFile(link: FileLink): void {
  window.dispatchEvent(new CustomEvent<FileLink>(EVENT, { detail: link }));
}

/** AppShell subscribes here and resolves/validates/opens the file. */
export function onOpenFileRequest(handler: (link: FileLink) => void): () => void {
  const fn = (e: Event) => handler((e as CustomEvent<FileLink>).detail);
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
