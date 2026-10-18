"use client";

import { useEffect, useRef, useState } from "react";
import { ScanLine, Square } from "lucide-react";
import { DialogShell } from "@/components/ui/DialogShell";
import { captureScreenshot, screenCaptureSupport, type Screenshot } from "@/lib/screen-capture";
import { useI18n } from "@/lib/i18n";
import { UI_ICON_SIZE } from "@/lib/ui-icons";
import { showToast } from "@/hooks/useToast";
import styles from "./ScreenshotButton.module.css";

/** Key this component by conversation/project so late captures cannot cross drafts. */
export function ScreenshotButton({ className, disabled, onAttach, onChooseFile }: {
  className: string;
  disabled: boolean;
  onAttach: (image: Screenshot) => void;
  onChooseFile: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Screenshot | null>(null);
  const [help, setHelp] = useState<"unsupported" | "insecure" | "failed" | null>(null);
  const active = useRef<AbortController | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const close = () => { setPreview(null); setHelp(null); };
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);

  const capture = async () => {
    if (disabled || active.current) return;
    const support = screenCaptureSupport();
    if (support !== "supported") { setHelp(support); return; }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    close();
    try {
      // No async import or permission preflight before this call: user activation
      // must still be available to the browser's native source picker.
      const image = await captureScreenshot(controller.signal);
      if (active.current === controller && !controller.signal.aborted) setPreview(image);
    } catch (error) {
      if (active.current !== controller || controller.signal.aborted) return;
      const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
      if (name === "NotSupportedError") setHelp("unsupported");
      else if (name === "NotAllowedError") showToast(t("capture.notAllowed"));
      else if (name !== "AbortError") setHelp("failed");
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  };

  return <>
    <button type="button" className={className} disabled={disabled}
      onClick={() => { if (active.current) active.current.abort(); else void capture(); }}
      aria-label={t(busy ? "capture.cancel" : "capture.take")}
      title={t(busy ? "capture.cancel" : "capture.take")}
      aria-busy={busy || undefined}>
      {busy ? <Square size={UI_ICON_SIZE.control} aria-hidden="true" /> : <ScanLine size={UI_ICON_SIZE.control} aria-hidden="true" />}
    </button>
    <DialogShell open={!!preview || !!help} title={t(preview ? "capture.preview" : "capture.take")}
      description={t(preview ? "capture.localOnly" : `capture.${help ?? "unsupported"}`)}
      modal placement="center" size={preview ? "wide" : "compact"} onClose={close}
      initialFocusRef={confirmRef} testId="screenshot-dialog"
      footer={<div className={styles.actions}>
        <button type="button" className={styles.button} onClick={close}>{t("common.cancel")}</button>
        {preview ? <>
          <button type="button" className={styles.button} disabled={disabled} onClick={() => void capture()}>{t("capture.retake")}</button>
          <button ref={confirmRef} type="button" className={styles.primary} disabled={disabled}
            onClick={() => { onAttach(preview); close(); }}>{t("capture.attach")}</button>
        </> : <button ref={confirmRef} type="button" className={styles.primary} disabled={disabled}
          onClick={() => { close(); onChooseFile(); }}>{t("capture.chooseImage")}</button>}
      </div>}>
      {preview ? <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preview.dataUrl} alt={t("capture.preview")} className={styles.preview} />
        <p className={styles.dimensions}>{preview.width} × {preview.height}</p>
      </> : <p className={styles.help}>{t("capture.fallback")}</p>}
    </DialogShell>
  </>;
}
