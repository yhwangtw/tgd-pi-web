"use client";

import { useRef } from "react";
import { DialogShell } from "@/components/ui/DialogShell";
import { useI18n } from "@/lib/i18n";
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
  return <DialogShell open title={t(preview ? "capture.preview" : "capture.take")}
    description={t(preview ? "capture.localOnly" : `capture.${help ?? "unsupported"}`)}
    modal placement="center" size={preview ? "wide" : "compact"} onClose={onClose}
    initialFocusRef={confirmRef} testId="screenshot-dialog"
    footer={<div className={styles.actions}>
      <button type="button" className={styles.button} onClick={onClose}>{t("common.cancel")}</button>
      {preview ? <>
        <button type="button" className={styles.button} disabled={disabled} onClick={onRetake}>{t("capture.retake")}</button>
        <button ref={confirmRef} type="button" className={styles.primary} disabled={disabled}
          onClick={() => { onAttach(preview); onClose(); }}>{t("capture.attach")}</button>
      </> : <button ref={confirmRef} type="button" className={styles.primary} disabled={disabled}
        onClick={() => { onClose(); onChooseFile(); }}>{t("capture.chooseImage")}</button>}
    </div>}>
    {preview ? <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={preview.dataUrl} alt={t("capture.preview")} className={styles.preview} />
      <p className={styles.dimensions}>{preview.width} × {preview.height}</p>
    </> : <p className={styles.help}>{t("capture.fallback")}</p>}
  </DialogShell>;
}
