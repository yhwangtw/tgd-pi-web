"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { X } from "lucide-react";

import { useEffect } from "react";
import { createPortal } from "react-dom";
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-label={t("image.preview")}>
      <button className={styles.close} onClick={onClose} aria-label={t("common.close")}><X size={UI_ICON_SIZE.control} aria-hidden="true" /></button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className={styles.image} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}
