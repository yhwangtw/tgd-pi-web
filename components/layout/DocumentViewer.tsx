"use client";

import { useEffect, useState, useRef } from "react";
import { encodeFilePathForApi, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { useI18n } from "@/lib/i18n";
import { formatSize, getFileExt, DOCX_PREVIEW_MAX_BYTES } from "./file-viewer-utils";
import { DownloadLink } from "./FileViewer";
import styles from "./DocumentViewer.module.css";

export function DocumentViewer({ filePath, cwd }: { filePath: string; cwd?: string }) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileExt(filePath);
  const encoded = encodeFilePathForApi(filePath);
  const isPdf = ext === "pdf";
  const previewUrl = isPdf
    ? `/api/files/${encoded}?type=read${bust ? `&v=${bust}` : ""}`
    : `/api/files/${encoded}?type=preview${bust ? `&v=${bust}` : ""}`;

  useEffect(() => {
    setBust(0);
    setSize(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    fetch(`/api/files/${encoded}?type=meta`)
      .then((r) => r.json())
      .then((d: { size?: number; error?: string }) => {
        if (d.error) setError(d.error);
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError(t("files.docxTooLarge"));
          }
        }
      })
      .catch((e) => setError(String(e)));

    const es = new EventSource(`/api/files/${encoded}?type=watch`);
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError(t("files.docxTooLarge"));
            return;
          }
        }
      } catch { /* ignore */ }
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [encoded, isPdf, t]);

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
            title={`Preview ${getFileName(filePath)}`}
            className={iframeClass}
          />
        )}
      </div>
    </div>
  );
}
