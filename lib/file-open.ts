export type FileOpenMode = "auto" | "source" | "preview" | "diff";

export type FileOpenOrigin =
  | { kind: "message"; entryId: string; sessionId?: string; label?: string }
  | { kind: "search"; query?: string; label?: string }
  | { kind: "explorer"; label?: string }
  | { kind: "git"; label?: string }
  | { kind: "tgd"; label?: string }
  | { kind: "review"; label?: string };

/** One canonical description of why and how a file was opened. */
export interface FileOpenIntent {
  path: string;
  label: string;
  line?: number;
  mode?: FileOpenMode;
  origin?: FileOpenOrigin;
}

export interface FileSelectionState {
  startLine: number;
  endLine: number;
  text: string;
}

export interface FileViewState {
  scrollTop: number;
  selection: FileSelectionState | null;
}
