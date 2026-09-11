import { getFileName } from "@/lib/file-paths";

export interface FileData {
  content: string;
  language: string;
  size: number;
  /** Exact disk revision required by compare-and-save. Absent on partial reads. */
  version?: string;
  /** Set when only the file's first chunk was returned (file > preview cap). */
  truncated?: boolean;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function getFileExt(filePath: string): string {
  return getFileName(filePath).toLowerCase().split(".").pop() ?? "";
}

export const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
