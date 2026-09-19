// Client helpers for the file-management API (POST/DELETE on /api/files).
import { encodeFilePathForApi } from "@/lib/file-paths";

async function post(dirOrFile: string, body: object): Promise<{ error?: string }> {
  const res = await fetch(`/api/files/${encodeFilePathForApi(dirOrFile)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = (await res.json().catch(() => ({}))) as { error?: string };
  return { error: res.ok ? undefined : d.error ?? `HTTP ${res.status}` };
}

export function createFile(parentDir: string, name: string) {
  return post(parentDir, { action: "create-file", name });
}
export function createDir(parentDir: string, name: string) {
  return post(parentDir, { action: "create-dir", name });
}
export function renameEntry(fullPath: string, name: string) {
  return post(fullPath, { action: "rename", name });
}

export async function deleteEntry(fullPath: string): Promise<{ error?: string }> {
  const res = await fetch(`/api/files/${encodeFilePathForApi(fullPath)}`, { method: "DELETE" });
  const d = (await res.json().catch(() => ({}))) as { error?: string };
  return { error: res.ok ? undefined : d.error ?? `HTTP ${res.status}` };
}

export interface UploadResult { name: string; ok: boolean; error?: string }

export async function uploadFiles(dir: string, files: File[], signal?: AbortSignal): Promise<{ results: UploadResult[]; error?: string }> {
  if (!files.length) return { results: [] };
  try {
    // The picker may select a workspace before Pi has saved any sessions in it.
    // Validate the explicit upload destination using the existing picker trust model.
    const selection = await fetch("/api/cwd/validate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: dir }), signal,
    });
    if (!selection.ok) {
      const data = await selection.json().catch(() => ({}));
      return { results: [], error: data.error ?? `HTTP ${selection.status}` };
    }
    // One file per request bounds server buffering even for multi-selection.
    const results: UploadResult[] = [];
    for (const file of files) {
      if (file.size > 50 * 1024 * 1024) {
        results.push({ name: file.name, ok: false, error: "Too large (>50MB)" });
        continue;
      }
      try {
        const form = new FormData();
        form.append("files", file);
        const res = await fetch(`/api/files/${encodeFilePathForApi(dir)}`, { method: "POST", body: form, signal });
        const data = await res.json().catch(() => ({})) as { results?: UploadResult[]; error?: string };
        const result = data.results?.[0];
        if (!res.ok) results.push({ name: file.name, ok: false, error: data.error ?? `HTTP ${res.status}` });
        else if (data.results?.length !== 1 || typeof result?.ok !== "boolean" || typeof result?.name !== "string") {
          results.push({ name: file.name, ok: false, error: "Invalid upload response" });
        } else results.push(result);
      } catch (error) {
        if (signal?.aborted) throw error;
        results.push({ name: file.name, ok: false, error: "Connection lost. Check Files before retrying." });
      }
    }
    if (results.some(r => r.ok)) window.dispatchEvent(new CustomEvent("pi:files-uploaded", { detail: { cwd: dir } }));
    return { results };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { results: [], error: "Connection lost. Check Files before retrying." };
  }
}
