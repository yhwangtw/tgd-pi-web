"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ScanLine, Square } from "lucide-react";
import { captureScreenshot, screenCaptureSupport, type Screenshot } from "@/lib/screen-capture";
import { useI18n } from "@/lib/i18n";
import { UI_ICON_SIZE } from "@/lib/ui-icons";
import { showToast } from "@/hooks/useToast";
const ScreenshotDialog = lazy(() => import("./ScreenshotDialog"));

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
    {(preview || help) && <Suspense fallback={null}>
      <ScreenshotDialog preview={preview} help={help} disabled={disabled}
        onClose={close} onRetake={() => void capture()} onChooseFile={onChooseFile}
        onAttach={onAttach} />
    </Suspense>}
  </>;
}
