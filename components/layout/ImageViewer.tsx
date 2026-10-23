"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeFilePathForApi, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { useFileWatch } from "@/hooks/useFileWatch";
import { useI18n } from "@/lib/i18n";
import { Minus, Plus, RotateCcw } from "lucide-react";
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
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ id: number; element: HTMLElement; x: number; y: number; startX: number; startY: number } | null>(null);
  const finishPan = useCallback(() => {
    const drag = panRef.current;
    panRef.current = null;
    setPanning(false);
    if (drag?.element.hasPointerCapture(drag.id)) drag.element.releasePointerCapture(drag.id);
  }, []);
  const resetView = useCallback(() => { finishPan(); setZoom(1); setPan({ x: 0, y: 0 }); }, [finishPan]);
  const changeZoom = useCallback((factor: number) => {
    finishPan();
    setZoom((z) => {
      const next = Math.min(8, Math.max(1, z * factor));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, [finishPan]);
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey || e.deltaY === 0) return;
    e.preventDefault();
    changeZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, [changeZoom]);
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLImageElement>) => {
    if (zoom <= 1 || e.button !== 0 || e.isPrimary === false || panRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = { id: e.pointerId, element: e.currentTarget, x: pan.x, y: pan.y, startX: e.clientX, startY: e.clientY };
    setPanning(true);
  }, [zoom, pan]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const p = panRef.current;
    if (!p || p.id !== e.pointerId) return;
    setPan({ x: p.x + (e.clientX - p.startX), y: p.y + (e.clientY - p.startY) });
  }, []);
  const onPointerEnd = useCallback((e: React.PointerEvent) => { if (panRef.current?.id === e.pointerId) finishPan(); }, [finishPan]);

  useEffect(() => {
    window.addEventListener("blur", finishPan);
    return () => { window.removeEventListener("blur", finishPan); finishPan(); };
  }, [finishPan]);

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
        <div className={styles.zoomControls}>
          <button type="button" className={styles.zoomReset} disabled={zoom <= 1} onClick={() => changeZoom(1 / 1.25)} aria-label={t("files.zoomOut")} title={t("files.zoomOut")}><Minus size={UI_ICON_SIZE.inline} aria-hidden="true" /></button>
          <button type="button" className={styles.zoomReset} onClick={resetView} title={t("files.resetZoom")} aria-label={t("files.resetZoom")}>
            {Math.round(zoom * 100)}% <RotateCcw size={UI_ICON_SIZE.inline} aria-hidden="true" />
          </button>
          <button type="button" className={styles.zoomReset} disabled={zoom >= 8} onClick={() => changeZoom(1.25)} aria-label={t("files.zoomIn")} title={t("files.zoomIn")}><Plus size={UI_ICON_SIZE.inline} aria-hidden="true" /></button>
        </div>
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
        style={{ cursor: zoom > 1 ? (panning ? "grabbing" : "grab") : "default" }}
      >
        {error ? (
          <div className={styles.error}>{error}<p>
            <a href={`/api/files/${encoded}?type=raw`} target="_blank" rel="noopener noreferrer">{t("files.openFull")}</a>{" · "}
            <a href={`/api/files/${encoded}?type=download`} download>{t("files.downloadFull")}</a>
          </p></div>
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
            onError={() => { finishPan(); setError(t("files.imageLoadFailed")); }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onLostPointerCapture={onPointerEnd}
            className={styles.image}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "center center" }}
          />
        )}
      </div>
    </div>
  );
}
