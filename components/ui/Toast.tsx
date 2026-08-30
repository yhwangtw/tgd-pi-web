"use client";

import { Check, CircleX, Info, TriangleAlert, X } from "lucide-react";
import type { ToastItem } from "@/hooks/useToast";
import { useI18n } from "@/lib/i18n";
import { IconButton } from "./IconButton";
import styles from "./Toast.module.css";

interface Props {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

const ICONS: Record<ToastItem["type"], React.ReactNode> = {
  success: <Check size={14} strokeWidth={2.5} />,
  error: <CircleX size={14} strokeWidth={2.5} />,
  warning: <TriangleAlert size={14} strokeWidth={2.5} />,
  info: <Info size={14} strokeWidth={2.5} />,
};

export function ToastContainer({ toasts, onDismiss }: Props) {
  const { t } = useI18n();
  if (toasts.length === 0) return null;
  return (
    <div className={styles.container} role="region" aria-label={t("common.notifications")} aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.type === "error" ? "alert" : "status"}
          className={`${styles.toast} ${styles[toast.type]}`}
        >
          <span className={styles.icon} aria-hidden>{ICONS[toast.type]}</span>
          <span className={styles.message}>{toast.message}</span>
          <IconButton
            size="compact"
            label={t("common.dismiss")}
            icon={<X strokeWidth={2.2} />}
            onClick={() => onDismiss(toast.id)}
          />
        </div>
      ))}
    </div>
  );
}
