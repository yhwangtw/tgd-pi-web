import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createFileMutationPathGuard, isFileMutationLockPath } from "@/lib/file-mutation-lock";
import {
  IGNORED_NAMES,
  IGNORED_SUFFIXES,
  TEXT_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  DOCX_PREVIEW_MAX_BYTES,
  filePathFromSegments,
  getAllowedRoots,
  isPathAllowed,
} from "@/lib/file-security";
import {
  getExt,
  getImageMime,
  getAudioMime,
  getVideoMime,
  getDocumentMime,
  getLanguage,
  documentPreviewKind,
} from "@/lib/file-mime";
import { streamFile, wrapDocxPreviewHtml } from "@/lib/file-stream";
import { previewContentSecurityPolicy } from "@/lib/preview-policy";
import { FileOperationError } from "@/lib/versioned-file";
import { FileSaveConflict, readEditableFile, saveEditableFile } from "@/lib/file-editor";
import { readTextPrefix } from "@/lib/text-prefix";
import { watchFileResponse } from "@/lib/file-watch";
import { coalesceFileRead } from "@/lib/file-read-coalescing";
import { validateEntryName } from "@/lib/file-name";
import { textPreviewLimit } from "@/lib/preview-limits";

async function handleRead(
  filePath: string,
  stat: fs.Stats,
  request: NextRequest,
  allowedRoots: Set<string>
): Promise<Response> {
  if (!stat.isFile()) {
    return NextResponse.json({ error: "Not a file" }, { status: 400 });
  }
  const imageMime = getImageMime(filePath);
  if (imageMime) {
    if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
      return NextResponse.json({ error: "Image too large (>10MB)" }, { status: 413 });
    }
    return streamFile(filePath, stat, imageMime, request.headers.get("range"), "inline", { signal: request.signal });
  }
  const audioMime = getAudioMime(filePath);
  if (audioMime) {
    return streamFile(filePath, stat, audioMime, request.headers.get("range"), "inline", { signal: request.signal });
  }
  const videoMime = getVideoMime(filePath);
  if (videoMime) {
    return streamFile(filePath, stat, videoMime, request.headers.get("range"), "inline", { signal: request.signal });
  }
  const documentMime = getDocumentMime(filePath);
  if (documentMime) {
    return streamFile(filePath, stat, documentMime, request.headers.get("range"), "inline", { signal: request.signal });
  }
  const language = getLanguage(filePath);
  const limit = textPreviewLimit(request.nextUrl.searchParams.get("previewBytes"));
  if (limit === null) return NextResponse.json({ error: "Invalid preview size" }, { status: 400 });
  if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
    // Partial preview instead of a refusal: first 256KB (on a UTF-8 char
    // boundary) + truncated flag. The viewer shows a banner with a download
    // link and disables editing (saving a prefix would destroy the file).
    const content = await coalesceFileRead(`text-prefix:${limit}`, filePath, stat, allowedRoots, () => readTextPrefix(filePath, limit));
    return NextResponse.json({ content, language, size: stat.size, truncated: Buffer.byteLength(content) < stat.size, previewBytes: limit });
  }
  const snapshot = await coalesceFileRead("text", filePath, stat, allowedRoots, () => readEditableFile(filePath, allowedRoots));
  return NextResponse.json({ ...snapshot, language });
}

function handleMeta(filePath: string, stat: fs.Stats): Response {
  if (!stat.isFile()) {
    return NextResponse.json({ error: "Not a file" }, { status: 400 });
  }
  const imageMime = getImageMime(filePath);
  const audioMime = getAudioMime(filePath);
  const videoMime = getVideoMime(filePath);
  const documentMime = getDocumentMime(filePath);
  return NextResponse.json({
    size: stat.size,
    language: getLanguage(filePath),
    mime: imageMime || audioMime || videoMime || documentMime || "text/plain",
    previewKind: documentPreviewKind(filePath),
  });
}

async function handlePreview(filePath: string, stat: fs.Stats, allowedRoots: Set<string>): Promise<Response> {
  if (!stat.isFile()) {
    return NextResponse.json({ error: "Not a file" }, { status: 400 });
  }
  if (getExt(filePath) !== "docx") {
    return NextResponse.json({ error: "Preview not available for this file type" }, { status: 400 });
  }
  if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
    return NextResponse.json({ error: "DOCX too large for preview (>10MB)" }, { status: 413 });
  }

  const html = await coalesceFileRead("docx", filePath, stat, allowedRoots, async () => {
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml(
      { path: filePath },
      { externalFileAccess: false, convertImage: mammoth.images.dataUri },
    );
    return wrapDocxPreviewHtml(result.value, path.basename(filePath));
  });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": previewContentSecurityPolicy(),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}


async function handleList(filePath: string, stat: fs.Stats): Promise<Response> {
  if (!stat.isDirectory()) return NextResponse.json({ error: "Not a directory" }, { status: 400 });
  const reserved = createFileMutationPathGuard(getAgentDir());
  const names = (await fs.promises.readdir(filePath))
    .filter(name => !IGNORED_NAMES.has(name) && !IGNORED_SUFFIXES.some(suffix => name.endsWith(suffix)))
    .filter(name => !reserved(path.join(filePath, name)));
  type ListedEntry = { name: string; isDir: boolean; size: number; modified: string };
  const entries: Array<ListedEntry | null> = Array(names.length);
  let next = 0;
  // Bound open filesystem work and keep large folders off the event loop.
  await Promise.all(Array.from({ length: Math.min(16, names.length) }, async () => {
    while (next < names.length) {
      const index = next++;
      const name = names[index];
      try {
        const child = await fs.promises.stat(path.join(filePath, name));
        entries[index] = { name, isDir: child.isDirectory(), size: child.isFile() ? child.size : 0, modified: child.mtime.toISOString() };
      } catch { entries[index] = null; }
    }
  }));
  const sorted = entries.filter((entry): entry is ListedEntry => entry !== null).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return NextResponse.json({ entries: sorted, path: filePath });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);
    const type = request.nextUrl.searchParams.get("type") ?? "list";

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    switch (type) {
      case "read":
        return await handleRead(filePath, stat, request, allowedRoots);
      case "download": {
        // Any file, any size — streamed with an attachment disposition so the
        // browser saves it instead of previewing.
        if (!stat.isFile()) {
          return NextResponse.json({ error: "Not a file" }, { status: 400 });
        }
        const mime = getImageMime(filePath) || getAudioMime(filePath) || getVideoMime(filePath) || getDocumentMime(filePath) || "application/octet-stream";
        return await streamFile(filePath, stat, mime, request.headers.get("range"), "attachment", { signal: request.signal });
      }
      case "raw": {
        // Any file, any size — streamed inline so the browser renders it
        // (the HTML preview iframe points its src here; no preview size cap).
        if (!stat.isFile()) {
          return NextResponse.json({ error: "Not a file" }, { status: 400 });
        }
        const ext = getExt(filePath);
        const mime =
          ext === "html" || ext === "htm"
            ? "text/html; charset=utf-8"
            : getImageMime(filePath) || getAudioMime(filePath) || getVideoMime(filePath) || getDocumentMime(filePath) || "text/plain; charset=utf-8";
        return await streamFile(filePath, stat, mime, request.headers.get("range"), "inline", { signal: request.signal });
      }
      case "meta":
        return handleMeta(filePath, stat);
      case "preview":
        return await handlePreview(filePath, stat, allowedRoots);
      case "html-preview": {
        if (!stat.isFile() || !["html", "htm"].includes(getExt(filePath))) {
          return NextResponse.json({ error: "HTML preview requires an HTML file" }, { status: 400 });
        }
        const { buildHtmlPreview } = await import("@/lib/html-preview");
        return NextResponse.json(await coalesceFileRead("html", filePath, stat, allowedRoots, () => buildHtmlPreview(filePath, allowedRoots)), { headers: { "Cache-Control": "private, no-store" } });
      }
      case "watch":
        return stat.isFile() ? watchFileResponse(filePath, request.signal) : NextResponse.json({ error: "Not a file" }, { status: 400 });
      case "list":
      default:
        return await handleList(filePath, stat);
    }
  } catch (error) {
    if (error instanceof FileOperationError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PUT /api/files/<path>  body: { content: string, expectedVersion: string }
// Saves a text file edited in the viewer. Existing files only (no create),
// same allowed-roots gate as reads, capped at the text-preview limit so the
// editor and the reader agree on what "a text file" is.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const body = await request.json() as { content?: unknown; expectedVersion?: unknown };
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content (string) is required" }, { status: 400 });
    }
    const bytes = Buffer.byteLength(body.content, "utf8");
    if (bytes > TEXT_PREVIEW_MAX_BYTES) {
      return NextResponse.json({ error: `Too large to save (${bytes} bytes)` }, { status: 413 });
    }

    const saved = await saveEditableFile(filePath, allowedRoots, body.content, body.expectedVersion);
    return NextResponse.json({ success: true, ...saved });
  } catch (error) {
    if (error instanceof FileSaveConflict) return NextResponse.json({ error: error.message, current: error.current }, { status: 409 });
    if (error instanceof FileOperationError) return NextResponse.json({ error: error.message }, { status: error.status });
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/files/<path>  — file management + upload
//   { action: "create-file", name }  create an empty file inside <path> (a dir)
//   { action: "create-dir",  name }  create a folder inside <path> (a dir)
//   { action: "rename", name }       rename <path> to <name> (same parent)
//   multipart/form-data with `files` — upload into <path> (a dir); existing
//   names are rejected per-file rather than overwritten.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const contentType = request.headers.get("content-type") ?? "";

    // ── Upload (multipart) ──
    if (contentType.includes("multipart/form-data")) {
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: "Upload target must be a folder" }, { status: 400 });
      }
      const form = await request.formData();
      const files = form.getAll("files").filter((f): f is File => f instanceof File);
      if (files.length === 0) {
        return NextResponse.json({ error: "No files" }, { status: 400 });
      }
      const MAX_UPLOAD = 50 * 1024 * 1024;
      const results: Array<{ name: string; ok: boolean; error?: string }> = [];
      for (const file of files) {
        const nameError = validateEntryName(file.name);
        if (nameError) { results.push({ name: file.name, ok: false, error: nameError }); continue; }
        if (file.size > MAX_UPLOAD) { results.push({ name: file.name, ok: false, error: "Too large (>50MB)" }); continue; }
        const dest = path.join(filePath, file.name.trim());
        if (!isPathAllowed(dest, allowedRoots)) { results.push({ name: file.name, ok: false, error: "Access denied" }); continue; }
        if (fs.existsSync(dest)) { results.push({ name: file.name, ok: false, error: "Already exists" }); continue; }
        try {
          // Exclusive creation also rejects dangling symlinks and races with
          // another upload: an existing project file is never overwritten.
          fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
          results.push({ name: file.name.trim(), ok: true });
        } catch (error) {
          results.push({ name: file.name, ok: false, error: (error as NodeJS.ErrnoException).code === "EEXIST" ? "Already exists" : "Could not write file" });
        }
      }
      return NextResponse.json({ results });
    }

    // ── JSON management actions ──
    const body = await request.json() as { action?: string; name?: string };
    const nameError = validateEntryName(body.name ?? "");
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });
    const name = (body.name ?? "").trim();

    if (body.action === "create-file" || body.action === "create-dir") {
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: "Parent must be a folder" }, { status: 400 });
      }
      const target = path.join(filePath, name);
      if (!isPathAllowed(target, allowedRoots)) return NextResponse.json({ error: "Access denied" }, { status: 403 });
      if (fs.existsSync(target)) {
        return NextResponse.json({ error: "Already exists" }, { status: 409 });
      }
      if (body.action === "create-dir") fs.mkdirSync(target);
      else fs.writeFileSync(target, "");
      return NextResponse.json({ ok: true, path: target });
    }

    if (body.action === "rename") {
      const target = path.join(path.dirname(filePath), name);
      if ([filePath, target].some(value => isFileMutationLockPath(value, getAgentDir(), { includeAncestors: true }))) {
        return NextResponse.json({ error: "Internal file-lock paths cannot be moved" }, { status: 403 });
      }
      if (target === filePath) return NextResponse.json({ ok: true, path: target });
      if (!isPathAllowed(target, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      if (fs.existsSync(target)) {
        return NextResponse.json({ error: "Already exists" }, { status: 409 });
      }
      fs.renameSync(filePath, target);
      return NextResponse.json({ ok: true, path: target });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/files/<path> — remove a file, or a folder recursively. The UI
// gates this behind an explicit confirm; the allowed-roots check above is the
// hard boundary.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    // Refuse to delete an allowed root itself (a project directory).
    if (isFileMutationLockPath(filePath, getAgentDir(), { includeAncestors: true })) {
      return NextResponse.json({ error: "Internal file-lock paths cannot be removed" }, { status: 403 });
    }
    for (const root of allowedRoots) {
      if (path.resolve(filePath) === path.resolve(root)) {
        return NextResponse.json({ error: "Cannot delete a project root" }, { status: 400 });
      }
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true });
    else fs.unlinkSync(filePath);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
