"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { uploadFiles } from "@/lib/file-ops-client";
import { validateEntryName } from "@/lib/file-name";
import { translate } from "@/lib/i18n";

interface UploadItem { id: number; file: File; error?: string }
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Only unfinished uploads live here; completed references belong to the draft. */
export function useFileAttachments(cwd: string | null | undefined, draftKey: string | null | undefined, onUploaded: (names: string[]) => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const epoch = useRef(0);
  const nextId = useRef(0);
  const controllers = useRef(new Map<number, AbortController>());
  const cancelled = useRef(new Set<number>());
  useLayoutEffect(() => {
    epoch.current++;
    setItems([]);
    cancelled.current.clear();
    const active = controllers.current;
    return () => {
      // This is a generation counter, not a captured DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++;
      active.forEach(c => c.abort()); active.clear();
    };
  }, [cwd, draftKey]);

  const addFiles = useCallback(async (files: File[]) => {
    const requestEpoch = epoch.current;
    const batch = files.map(file => ({ id: ++nextId.current, file, error:
      !cwd ? translate("input.uploadNeedsProject") :
      file.size > MAX_FILE_BYTES ? translate("input.uploadTooLarge") : validateEntryName(file.name) ?? undefined,
    }));
    setItems(prev => [...prev, ...batch]);
    // Sequential requests keep memory bounded and preserve selection order.
    for (const item of batch) {
      if (item.error || requestEpoch !== epoch.current || cancelled.current.has(item.id) || !cwd) continue;
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      try {
        const result = await uploadFiles(cwd, [item.file], controller.signal);
        if (requestEpoch !== epoch.current) return;
        if (cancelled.current.has(item.id)) continue;
        const uploaded = result.results[0];
        if (uploaded?.ok) {
          onUploaded([uploaded.name]);
          setItems(prev => prev.filter(row => row.id !== item.id));
        } else {
          const raw = result.error ?? uploaded?.error ?? "Upload failed";
          const error = raw === "Already exists" ? translate("input.uploadExists") : raw;
          setItems(prev => prev.map(row => row.id === item.id ? { ...row, error } : row));
        }
      } catch {
        // Scope changes abort requests; never insert into another conversation.
      } finally { controllers.current.delete(item.id); }
    }
  }, [cwd, onUploaded]);
  const dismiss = useCallback((id: number) => {
    cancelled.current.add(id);
    controllers.current.get(id)?.abort();
    setItems(prev => prev.filter(item => item.id !== id));
  }, []);
  const retry = useCallback((item: UploadItem) => { dismiss(item.id); void addFiles([item.file]); }, [addFiles, dismiss]);
  return { items, addFiles, dismiss, retry, uploading: items.some(item => !item.error) };
}
