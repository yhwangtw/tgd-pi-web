"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeFilePathForApi, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { useFileWatch } from "@/hooks/useFileWatch";
import { useI18n } from "@/lib/i18n";
import { RotateCcw } from "lucide-react";
import { formatSize } from "./file-viewer-utils";
import styles from "./ImageViewer.module.css";

export function ImageViewer({ filePath, cwd }: { filePath: string; cwd?: string }) {
  const { t } = useI18n();
  const { watching, refreshTrigger } = useFileWatch(filePath);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Zoom / pan ──
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => {
      const next = Math.min(8, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (zoom <= 1) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    panRef.current = { x: pan.x, y: pan.y, startX: e.clientX, startY: e.clientY };
  }, [zoom, pan]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const p = panRef.current;
    if (!p) return;
    setPan({ x: p.x + (e.clientX - p.startX), y: p.y + (e.clientY - p.startY) });
  }, []);
  const onPointerUp = useCallback(() => { panRef.current = null; }, []);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setNaturalSize(null);
    setError(null);
    resetView();
  }, [filePath, resetView]);

  // Bust image cache on each file-watch change event
  useEffect(() => {
    if (refreshTrigger > 0) {
      setBust((b) => b + 1);
      setSize(null);
      setNaturalSize(null);
      setError(null);
    }
  }, [refreshTrigger]);

  const encoded = encodeFilePathForApi(filePath);
  const src = `/api/files/${encoded}?type=read${bust ? `&v=${bust}` : ""}`;

  const formatSizeStr = size != null ? formatSize(size) : null;

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.filePath} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span className={styles.extension}>{ext || t("files.imageType")}</span>
        {naturalSize && <span>{naturalSize.w} × {naturalSize.h}</span>}
        {formatSizeStr && <span>{formatSizeStr}</span>}
        {zoom !== 1 && (
          <button type="button" className={styles.zoomReset} onClick={resetView} title={t("files.resetZoom")} aria-label={t("files.resetZoom")}>
            {Math.round(zoom * 100)}% <RotateCcw size={12} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
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
      <div
        className={styles.imageContainer}
        onWheel={onWheel}
        onDoubleClick={resetView}
        style={{ cursor: zoom > 1 ? (panRef.current ? "grabbing" : "grab") : "default" }}
      >
        {error ? (
          <div className={styles.error}>{error}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={filePath}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setError("Failed to load image")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className={styles.image}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "center center" }}
          />
        )}
      </div>
    </div>
  );
}
