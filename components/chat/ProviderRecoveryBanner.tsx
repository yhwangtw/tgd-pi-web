"use client";

import type { ProviderErrorKind, ProviderRecoveryModel } from "@/lib/provider-recovery";
import { useI18n } from "@/lib/i18n";
import s from "./ProviderRecoveryBanner.module.css";

export interface ProviderRecoveryView {
  message: string;
  kind: ProviderErrorKind;
  retryAfterSeconds: number | null;
  candidate: ProviderRecoveryModel | null;
  automatic: boolean;
}

interface Props {
  recovery: ProviderRecoveryView;
  busy: boolean;
  onRetryWithModel: (model: ProviderRecoveryModel) => void | Promise<void>;
  onAutomaticChange: (enabled: boolean) => void;
  onDismiss: () => void;
}

export function ProviderRecoveryBanner({ recovery, busy, onRetryWithModel, onAutomaticChange, onDismiss }: Props) {
  const { t } = useI18n();
  return (
    <section className={s.root} role="status" aria-label={t("recovery.title")}>
      <div className={s.icon} aria-hidden>↻</div>
      <div className={s.body}>
        <div className={s.titleRow}>
          <strong>{t(`recovery.kind.${recovery.kind}`)}</strong>
          <button type="button" className={s.dismiss} onClick={onDismiss} aria-label={t("common.close")}>×</button>
        </div>
        <p>{recovery.message}</p>
        {recovery.retryAfterSeconds !== null && <span className={s.retryAfter}>{t("recovery.retryAfter").replace("{seconds}", String(recovery.retryAfterSeconds))}</span>}
        <div className={s.actions}>
          {recovery.candidate && (
            <button type="button" className={s.primary} disabled={busy} onClick={() => void onRetryWithModel(recovery.candidate as ProviderRecoveryModel)}>
              {t("recovery.retryWith").replace("{model}", recovery.candidate.name)}
            </button>
          )}
          <label>
            <input type="checkbox" checked={recovery.automatic} onChange={(event) => onAutomaticChange(event.target.checked)} />
            <span>{t("recovery.automatic")}</span>
          </label>
        </div>
      </div>
    </section>
  );
}
