"use client";

import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, CircleX, Info, ChevronDown } from "lucide-react";
import type { OutputCardKind } from "@/lib/output-design";
import { useI18n } from "@/lib/i18n";
import styles from "./StructuredOutputCard.module.css";

const ICONS = {
  result: CheckCircle2,
  info: Info,
  warning: CircleAlert,
  error: CircleX,
} satisfies Record<OutputCardKind, typeof CheckCircle2>;

export function StructuredOutputCard({
  kind,
  title,
  detailsTitle,
  children,
  details,
}: {
  kind: OutputCardKind;
  title?: string;
  detailsTitle?: string;
  children: ReactNode;
  details?: ReactNode;
}) {
  const { t } = useI18n();
  const Icon = ICONS[kind];
  const label = t(`output.${kind}` as Parameters<typeof t>[0]);

  return (
    <section
      className={`${styles.root} ${styles[kind]}`}
      data-output-kind={kind}
      data-testid="structured-output-card"
      aria-label={title ? `${label}: ${title}` : label}
    >
      <div className={styles.eyebrow}>{label}</div>
      <div className={styles.contentRow}>
        <Icon className={styles.icon} size={19} strokeWidth={2} aria-hidden="true" />
        <div className={styles.content}>
          {title && <h4 className={styles.title}>{title}</h4>}
          {children}
        </div>
      </div>
      {details && (
        <details className={styles.details}>
          <summary>
            <span className={styles.detailsTitle}>{detailsTitle || t("output.technicalDetails")}</span>
            <ChevronDown className={styles.chevron} size={15} strokeWidth={1.8} aria-hidden="true" />
            <span className={styles.detailsHint}>{t("output.detailsHint")}</span>
          </summary>
          <div className={styles.detailsBody}>{details}</div>
        </details>
      )}
    </section>
  );
}
