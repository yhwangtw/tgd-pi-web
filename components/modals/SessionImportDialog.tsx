"use client";

import { useEffect, useState } from "react";
import type { SessionImportPreview } from "@/lib/session-import";
import { useI18n } from "@/lib/i18n";
import styles from "./SessionImportDialog.module.css";

interface Props {
  sessionId: string;
  onClose: () => void;
  onImported: (sessionId: string, cwd: string, sessionFile: string) => void;
}

interface ImportResponse {
  error?: string;
  preview?: SessionImportPreview;
  result?: { cancelled: boolean; newSessionId?: string; cwd?: string; sessionFile?: string };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SessionImportDialog({ sessionId, onClose, onImported }: Props) {
  const { t } = useI18n();
  const [filePath, setFilePath] = useState("");
  const [cwdOverride, setCwdOverride] = useState("");
  const [preview, setPreview] = useState<SessionImportPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const request = async (action: "preview" | "import") => {
    if (!filePath.trim() || busy) return;
    setBusy(action);
    setError("");
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          path: filePath.trim(),
          ...(cwdOverride.trim() ? { cwdOverride: cwdOverride.trim() } : {}),
        }),
      });
      const payload = await response.json() as ImportResponse;
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      if (action === "preview") {
        setPreview(payload.preview ?? null);
        return;
      }
      const result = payload.result;
      if (!result || result.cancelled) throw new Error(t("sessionImport.cancelled"));
      if (!result.newSessionId || !result.cwd || !result.sessionFile) {
        throw new Error(t("sessionImport.invalidResponse"));
      }
      onImported(result.newSessionId, result.cwd, result.sessionFile);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      if (action === "preview") setPreview(null);
    } finally {
      setBusy(null);
    }
  };

  const resetPreview = () => {
    setPreview(null);
    setError("");
  };

  return (
    <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="session-import-title">
        <header className={styles.header}>
          <div>
            <h2 id="session-import-title">{t("sessionImport.title")}</h2>
            <p>{t("sessionImport.description")}</p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} disabled={!!busy} aria-label={t("common.close")}>×</button>
        </header>

        <div className={styles.body}>
          <label className={styles.field}>
            <span>{t("sessionImport.path")}</span>
            <input
              autoFocus
              value={filePath}
              onChange={(event) => { setFilePath(event.target.value); resetPreview(); }}
              placeholder="/path/to/session.jsonl"
              spellCheck={false}
              disabled={!!busy}
            />
          </label>
          <label className={styles.field}>
            <span>{t("sessionImport.cwdOverride")}</span>
            <input
              value={cwdOverride}
              onChange={(event) => { setCwdOverride(event.target.value); resetPreview(); }}
              placeholder={t("sessionImport.cwdPlaceholder")}
              spellCheck={false}
              disabled={!!busy}
            />
          </label>
          <p className={styles.securityNote}>{t("sessionImport.securityNote")}</p>

          {error && <div className={styles.error} role="alert">{error}</div>}
          {preview && (
            <div className={styles.preview} data-testid="session-import-preview">
              <div className={styles.previewTitle}>{preview.name || preview.fileName}</div>
              <dl>
                <div><dt>{t("sessionImport.sessionId")}</dt><dd>{preview.sessionId}</dd></div>
                <div><dt>{t("sessionImport.cwd")}</dt><dd>{preview.cwd}</dd></div>
                <div><dt>{t("sessionImport.messages")}</dt><dd>{preview.messageCount}</dd></div>
                <div><dt>{t("sessionImport.size")}</dt><dd>{formatBytes(preview.size)}</dd></div>
              </dl>
            </div>
          )}
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.secondary} onClick={onClose} disabled={!!busy}>{t("common.cancel")}</button>
          {!preview ? (
            <button type="button" className={styles.primary} onClick={() => void request("preview")} disabled={!filePath.trim() || !!busy}>
              {busy === "preview" ? t("sessionImport.previewing") : t("sessionImport.preview")}
            </button>
          ) : (
            <button type="button" className={styles.primary} onClick={() => void request("import")} disabled={!!busy}>
              {busy === "import" ? t("sessionImport.importing") : t("sessionImport.import")}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
