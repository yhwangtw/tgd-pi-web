"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { X } from "lucide-react";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "@/hooks/useModalDialog";
import styles from "./ImageLightbox.module.css";
import { useI18n } from "@/lib/i18n";

interface Props {
  src: string;
  onClose: () => void;
}

/**
 * Full-screen image viewer for transcript attachments — thumbnails are too
 * small to read a screenshot, especially on a phone. Click anywhere or press
 * Escape to close. Portalled to <body> (the transcript scroller would clip a
 * fixed overlay rendered inside it on some stacking contexts).
 */
export function ImageLightbox({ src, onClose }: Props) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const { panelRef } = useModalDialog<HTMLDivElement>({ open: true, onClose, initialFocusRef: closeRef });

  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={panelRef} data-dialog-root className={styles.overlay} tabIndex={-1} onClick={onClose} role="dialog" aria-modal="true" aria-label={t("image.preview")}>
      <button ref={closeRef} type="button" className={styles.close} onClick={(event) => { event.stopPropagation(); onClose(); }} aria-label={t("common.close")}><X size={UI_ICON_SIZE.control} aria-hidden="true" /></button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className={styles.image} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}
