export const TEXT_PREVIEW_CHUNK_BYTES = 256 * 1024;
export const TEXT_PREVIEW_EXPANDED_MAX_BYTES = 2 * 1024 * 1024;

export function textPreviewLimit(value: string | null): number | null {
  if (value === null) return TEXT_PREVIEW_CHUNK_BYTES;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= TEXT_PREVIEW_CHUNK_BYTES && parsed <= TEXT_PREVIEW_EXPANDED_MAX_BYTES
    ? parsed : null;
}
