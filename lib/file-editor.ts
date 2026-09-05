import path from "node:path";
import { isPathAllowed, TEXT_PREVIEW_MAX_BYTES } from "./file-security";
import { FileOperationError, readFileSnapshot, replaceFileSnapshot, withFileMutation } from "./versioned-file";

export interface EditableFile {
  content: string;
  version: string;
  size: number;
}

export class FileSaveConflict extends FileOperationError {
  constructor(public readonly current: EditableFile) {
    super("File changed on disk; review the current version before saving", 409);
  }
}

function editorLocation(filePath: string, roots: Set<string>) {
  const root = [...roots].filter(candidate => isPathAllowed(filePath, new Set([candidate])))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) throw new FileOperationError("Access denied", 403);
  return { root, relative: path.relative(root, filePath) };
}

export async function readEditableFile(filePath: string, roots: Set<string>): Promise<EditableFile> {
  const location = editorLocation(filePath, roots);
  const snapshot = await readFileSnapshot(location.root, location.relative, TEXT_PREVIEW_MAX_BYTES);
  if (!snapshot.exists) throw new FileOperationError("Not found", 404);
  return { content: snapshot.text, version: snapshot.version, size: Buffer.byteLength(snapshot.text) };
}

export async function saveEditableFile(filePath: string, roots: Set<string>, content: string, expectedVersion: unknown): Promise<EditableFile> {
  const location = editorLocation(filePath, roots);
  if (typeof expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(expectedVersion)) {
    throw new FileOperationError("Load the file version before saving", 428);
  }
  if (Buffer.byteLength(content) > TEXT_PREVIEW_MAX_BYTES) throw new FileOperationError("File is too large", 413);
  if (content.includes("\0") || Buffer.from(content).toString("utf8") !== content) {
    throw new FileOperationError("Only valid UTF-8 text can be saved", 415);
  }
  return withFileMutation(location.root, location.relative, async () => {
    const current = await readFileSnapshot(location.root, location.relative, TEXT_PREVIEW_MAX_BYTES);
    if (!current.exists) throw new FileOperationError("Not found", 404);
    if (current.version !== expectedVersion) {
      throw new FileSaveConflict({ content: current.text, version: current.version, size: Buffer.byteLength(current.text) });
    }
    await replaceFileSnapshot(location.root, location.relative, current, content, TEXT_PREVIEW_MAX_BYTES);
    return readEditableFile(filePath, roots);
  });
}
