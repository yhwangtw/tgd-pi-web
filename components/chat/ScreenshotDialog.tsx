"use client";

import { useId, useRef, useState, type PointerEvent } from "react";
import { DialogShell } from "@/components/ui/DialogShell";
import { useI18n } from "@/lib/i18n";
import { adjustCrop, cropPoint, cropRectangle, cropScreenshot, type CropPoint, type CropRect } from "@/lib/screenshot-crop";
import type { Screenshot } from "@/lib/screen-capture";
import styles from "./ScreenshotButton.module.css";

/** Loaded only after capture or when fallback help is needed. */
export default function ScreenshotDialog({ preview, help, disabled, onClose, onRetake, onAttach, onChooseFile }: {
  preview: Screenshot | null;
  help: "unsupported" | "insecure" | "failed" | null;
  disabled: boolean;
  onClose: () => void;
  onRetake: () => void;
  onAttach: (image: Screenshot) => void;
  onChooseFile: () => void;
}) {
  const { t } = useI18n();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; start: CropPoint; previous: CropRect | null } | null>(null);
  const [selection, setSelection] = useState<CropRect | null>(null);
  const [dragging, setDragging] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const hintId = useId();
  const point = (event: PointerEvent<HTMLDivElement>) => cropPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), preview!);
  const cancelDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    setSelection(drag.current.previous); drag.current = null; setDragging(false);
  };
  const attach = () => {
    if (!preview || dragging) return;
    try {
      const image = selection ? cropScreenshot(imageRef.current!, selection) : preview;
      onAttach(image); onClose();
    } catch { setFailed(true); }
  };
  return <DialogShell open title={t(preview ? "capture.preview" : "capture.take")}
    description={t(preview ? "capture.localOnly" : `capture.${help ?? "unsupported"}`)}
    modal placement="center" size={preview ? "wide" : "compact"} onClose={onClose}
    initialFocusRef={preview ? stageRef : confirmRef} testId="screenshot-dialog"
    footer={<div className={styles.actions}>
      <button type="button" className={styles.button} onClick={onClose}>{t("common.cancel")}</button>
      {preview ? <>
        <button type="button" className={styles.button} disabled={disabled} onClick={onRetake}>{t("capture.retake")}</button>
        <button type="button" className={styles.button} disabled={disabled || !selection || dragging}
          onClick={() => { setSelection(null); setFailed(false); }}>{t("capture.reset")}</button>
        <button ref={confirmRef} type="button" className={styles.primary} disabled={disabled || dragging || (!!selection && !ready)}
          onClick={attach}>{t(selection ? "capture.attachArea" : "capture.attach")}</button>
      </> : <button ref={confirmRef} type="button" className={styles.primary} disabled={disabled}
        onClick={() => { onClose(); onChooseFile(); }}>{t("capture.chooseImage")}</button>}
    </div>}>
    {preview ? <>
      <p id={hintId} className={styles.hint}>{t("capture.select")}</p>
      <div ref={stageRef} className={styles.cropStage} role="group" tabIndex={0} aria-label={t("capture.preview")}
        aria-describedby={hintId} data-testid="screenshot-crop"
        style={{ width: `min(100%, ${55 * preview.width / preview.height}dvh)`, aspectRatio: `${preview.width} / ${preview.height}` }}
        onPointerDown={event => {
          if (disabled || event.button !== 0 || drag.current) return;
          event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, start: point(event), previous: selection };
          setDragging(true); setFailed(false);
        }}
        onPointerMove={event => {
          if (!drag.current || drag.current.id !== event.pointerId) return;
          setSelection(cropRectangle(drag.current.start, point(event)));
        }}
        onPointerUp={event => {
          if (!drag.current || drag.current.id !== event.pointerId) return;
          const rect = cropRectangle(drag.current.start, point(event));
          setSelection(rect.width && rect.height ? rect : drag.current.previous);
          drag.current = null; setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
        onKeyDown={event => {
          if (disabled || dragging || event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault(); setFailed(false);
          const initial = { x: Math.floor(preview.width / 4), y: Math.floor(preview.height / 4), width: Math.max(1, Math.floor(preview.width / 2)), height: Math.max(1, Math.floor(preview.height / 2)) };
          setSelection(previous => adjustCrop(previous ?? initial, event.key, event.shiftKey, preview));
        }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={imageRef} src={preview.dataUrl} alt={t("capture.preview")} className={styles.preview}
          draggable={false} onLoad={() => setReady(true)} onError={() => { setReady(false); setFailed(true); }} />
        {selection && <span className={styles.selection} aria-hidden="true" style={{
          left: `${selection.x / preview.width * 100}%`, top: `${selection.y / preview.height * 100}%`,
          width: `${selection.width / preview.width * 100}%`, height: `${selection.height / preview.height * 100}%`,
        }} />}
      </div>
      <p className={styles.dimensions} aria-live={dragging ? "off" : "polite"}>{selection?.width ?? preview.width} × {selection?.height ?? preview.height}</p>
      {failed && <p className={styles.error} role="alert">{t("capture.cropError")}</p>}
    </> : <p className={styles.help}>{t("capture.fallback")}</p>}
  </DialogShell>;
}
