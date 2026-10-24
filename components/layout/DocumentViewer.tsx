"use client";

import { useEffect, useState } from "react";
import { encodeFilePathForApi, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { useFileWatch } from "@/hooks/useFileWatch";
import { useI18n } from "@/lib/i18n";
import { formatSize, getFileExt, DOCX_PREVIEW_MAX_BYTES } from "./file-viewer-utils";
import { DownloadLink } from "./FileViewer";
import styles from "./DocumentViewer.module.css";

export function DocumentViewer({ filePath, cwd, visible = true }: { filePath: string; cwd?: string; visible?: boolean }) {
  const { t } = useI18n();
  const { watching, refreshTrigger: bust } = useFileWatch(filePath, visible);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ext = getFileExt(filePath);
  const encoded = encodeFilePathForApi(filePath);
  const isPdf = ext === "pdf";
  const previewUrl = isPdf
    ? `/api/files/${encoded}?type=read${bust ? `&v=${bust}` : ""}`
    : `/api/files/${encoded}?type=preview${bust ? `&v=${bust}` : ""}`;

  useEffect(() => {
    const controller = new AbortController();
    setSize(null);
    setError(null);
    fetch(`/api/files/${encoded}?type=meta`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { size?: number; error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (controller.signal.aborted) return;
        if (typeof data.size === "number") {
          setSize(data.size);
          if (!isPdf && data.size > DOCX_PREVIEW_MAX_BYTES) setError(t("files.docxTooLarge"));
        }
      })
      .catch((error) => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, [encoded, isPdf, t, bust]);

  const iframeClass = `${styles.iframe} ${isPdf ? styles.iframePdf : styles.iframeDocx}`;

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.filePath} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span className={styles.extension}>{ext === "docx" ? t("files.docxPreview") : "PDF"}</span>
        {size != null && <span>{formatSize(size)}</span>}
        <DownloadLink filePath={filePath} />
        <span
          title={t(watching ? "files.liveSyncActive" : "files.notWatching")}
          className={`${styles.watchStatus} ${watching ? styles.watchStatusLive : styles.watchStatusStatic}`}
        >
          <span
            className={`${styles.watchDot} ${watching ? styles.watchDotLive : styles.watchDotStatic}`}
          />
          {t(watching ? "files.live" : "files.static")}
        </span>
      </div>
      <div className={styles.content}>
        {error ? (
          <div className={styles.errorContainer}>
            {error}
          </div>
        ) : (
          <iframe
            key={previewUrl}
            src={previewUrl}
            sandbox={isPdf ? undefined : ""}
            title={`${t("files.preview")} ${getFileName(filePath)}`}
            className={iframeClass}
          />
        )}
      </div>
    </div>
  );
}
