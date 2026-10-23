"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "@/hooks/useModalDialog";
import { validateEntryName } from "@/lib/file-name";
import { useI18n } from "@/lib/i18n";
import styles from "./FileOpsDialog.module.css";

export type FileOpKind = "new-file" | "new-folder" | "rename" | "delete";

export interface FileOpRequest {
  kind: FileOpKind;
  /** For new-file/new-folder: the parent dir. For rename/delete: the target. */
  targetPath: string;
  /** Display label (relative path or name). */
  label: string;
  /** Current name (rename prefill). */
  currentName?: string;
  isDir?: boolean;
}

interface Props {
  req: FileOpRequest;
  onClose: () => void;
  /** Resolve name (create/rename) or confirm (delete). Return an error string to keep open. */
  onSubmit: (name: string) => Promise<string | null>;
}

export function FileOpsDialog({ req, onClose, onSubmit }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState(req.currentName ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const isNameOp = req.kind !== "delete";
  const { panelRef } = useModalDialog<HTMLDivElement>({ open: true, onClose, canClose: !busy, initialFocusRef: isNameOp ? inputRef : cancelRef });

  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      // Select the basename (before extension) for quick rename.
      const dot = (req.currentName ?? "").lastIndexOf(".");
      if (req.kind === "rename" && dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    }
  }, [req]);

  const submit = async () => {
    if (busy) return;
    if (isNameOp) {
      const err = validateEntryName(name);
      if (err) { setError(err); return; }
    }
    setBusy(true);
    setError("");
    try {
      const err = await onSubmit(name.trim());
      if (err) { setError(err); setBusy(false); return; }
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("fileops.operationFailed"));
      setBusy(false);
    }
  };

  const titles: Record<FileOpKind, string> = {
    "new-file": t("fileops.newFileTitle"),
    "new-folder": t("fileops.newFolderTitle"),
    "rename": t("fileops.renameTitle"),
    "delete": t("fileops.deleteTitle"),
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div data-dialog-root className={styles.overlay} onMouseDown={(e) => { if (!busy && e.target === e.currentTarget) onClose(); }}>
      <div ref={panelRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} data-testid="file-ops-dialog">
        <div id={titleId} className={styles.title}>{titles[req.kind]}</div>
        <div id={descriptionId} className={styles.subtitle}>{req.label}</div>

        {isNameOp ? (
          <>
            <input
              ref={inputRef}
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              placeholder={req.kind === "new-folder" ? t("fileops.folderName") : t("fileops.fileName")}
              spellCheck={false}
              aria-label={t("fileops.name")}
            />
            <div className={styles.error} role="alert">{error}</div>
          </>
        ) : (
          <div className={styles.error} role="alert" style={{ minHeight: 0 }}>{error || t("fileops.deleteWarn")}</div>
        )}

        <div className={styles.actions}>
          <button ref={cancelRef} type="button" className={styles.btn} onClick={onClose} disabled={busy}>{t("fileops.cancel")}</button>
          <button
            type="button"
            className={`${styles.btn} ${req.kind === "delete" ? styles.danger : styles.primary}`}
            onClick={() => void submit()}
            disabled={busy || (isNameOp && !name.trim())}
          >
            {req.kind === "delete" ? t("fileops.delete") : t("fileops.confirm")}
          </button>
        </div>
      </div>
    </div>, document.body,
  );
}
