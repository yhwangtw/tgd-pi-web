/** Shared by filename search, content search and saved views. No server imports. */
export interface FileSearchOptions {
  includeHidden: boolean;
  includeIgnored: boolean;
  includeWorktrees: boolean;
}

export const DEFAULT_FILE_SEARCH_OPTIONS: FileSearchOptions = {
  includeHidden: false,
  includeIgnored: false,
  includeWorktrees: false,
};

export function normalizeFileSearchOptions(value?: Partial<FileSearchOptions> | null): FileSearchOptions {
  return {
    includeHidden: value?.includeHidden === true,
    includeIgnored: value?.includeIgnored === true,
    includeWorktrees: value?.includeWorktrees === true,
  };
}

export function fileSearchOptionsFromParams(params: URLSearchParams): FileSearchOptions {
  return {
    includeHidden: params.get("hidden") === "1",
    includeIgnored: params.get("ignored") === "1",
    includeWorktrees: params.get("worktrees") === "1",
  };
}

export function fileSearchOptionsQuery(value: FileSearchOptions): string {
  return `&hidden=${Number(value.includeHidden)}&ignored=${Number(value.includeIgnored)}&worktrees=${Number(value.includeWorktrees)}`;
}
