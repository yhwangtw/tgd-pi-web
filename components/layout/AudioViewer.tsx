"use client";

import { useEffect, useState } from "react";
import { encodeFilePathForApi, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { useFileWatch } from "@/hooks/useFileWatch";
import { formatSize, formatDuration } from "./file-viewer-utils";
import styles from "./MediaViewer.module.css";

export function AudioViewer({ filePath, cwd, visible = true }: { filePath: string; cwd?: string; visible?: boolean }) {
  const { watching, refreshTrigger } = useFileWatch(filePath, visible);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
  }, [filePath]);

  // Bust audio cache on each file-watch change event
  useEffect(() => {
    if (refreshTrigger > 0) {
      setBust((b) => b + 1);
      setDuration(null);
      setError(null);
    }
  }, [refreshTrigger]);

  const encoded = encodeFilePathForApi(filePath);
  const src = `/api/files/${encoded}?type=read${bust ? `&v=${bust}` : ""}`;

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.path} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span>{ext || "audio"}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={watching ? "Live sync active" : "Not watching"}
          className={watching ? styles.live : styles.static}
        >
          <span aria-hidden="true" className={styles.watchDot} />
          {watching ? "live" : "static"}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "var(--color-error-text)", fontSize: "var(--text-md)", marginBottom: "var(--space-3)", textAlign: "center" }}>
              {error}
            </div>
          )}
          <audio
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError("Failed to load audio")}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}
