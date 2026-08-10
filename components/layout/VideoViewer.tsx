"use client";

import { useEffect, useState } from "react";
import { encodeFilePathForApi, getRelativeFilePath } from "@/lib/file-paths";
import { useFileWatch } from "@/hooks/useFileWatch";
import { formatDuration, formatSize, getFileExt } from "./file-viewer-utils";
import styles from "./MediaViewer.module.css";

export function VideoViewer({ filePath, cwd }: { filePath: string; cwd?: string }) {
  const { watching, refreshTrigger } = useFileWatch(filePath);
  const [duration, setDuration] = useState<number | null>(null);
  const [dimensions, setDimensions] = useState<string>("");
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const encoded = encodeFilePathForApi(filePath);
  const src = `/api/files/${encoded}?type=raw${refreshTrigger ? `&v=${refreshTrigger}` : ""}`;

  useEffect(() => {
    setDuration(null);
    setDimensions("");
    setError(null);
    fetch(`/api/files/${encoded}?type=meta`).then((response) => response.json()).then((data: { size?: number }) => {
      if (typeof data.size === "number") setSize(data.size);
    }).catch(() => setSize(null));
  }, [encoded, refreshTrigger]);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.path} title={filePath}>{getRelativeFilePath(filePath, cwd)}</span>
        <span>{getFileExt(filePath) || "video"}</span>
        {dimensions && <span>{dimensions}</span>}
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <span className={watching ? styles.live : styles.static}>{watching ? "● live" : "○ static"}</span>
      </div>
      <div className={styles.stage}>
        {error ? <div className={styles.error}>{error}</div> : (
          <video
            key={src}
            src={src}
            controls
            playsInline
            preload="metadata"
            className={styles.video}
            onLoadedMetadata={(event) => {
              setDuration(event.currentTarget.duration);
              setDimensions(`${event.currentTarget.videoWidth} × ${event.currentTarget.videoHeight}`);
            }}
            onError={() => setError("Failed to load video")}
          />
        )}
      </div>
    </div>
  );
}
