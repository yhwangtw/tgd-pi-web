"use client";

import { classifyProviderError, type ProviderErrorKind, type ProviderRecoveryModel } from "@/lib/provider-recovery";
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
  onAdjustThinking?: () => void;
}

export function ProviderRecoveryBanner({ recovery, busy, onRetryWithModel, onAutomaticChange, onDismiss, onAdjustThinking }: Props) {
  const { t } = useI18n();
  const canFallback = classifyProviderError(recovery.message).recoverableWithFallback;
  return (
    <section className={s.root} aria-label={t("recovery.options")}>
      <div className={s.body}>
        <div className={s.titleRow}>
          <strong>{t("recovery.options")}</strong>
          <button type="button" className={s.dismiss} onClick={onDismiss} aria-label={t("common.close")}>×</button>
        </div>
        {recovery.kind === "model_unavailable" && <p>{t("recovery.chooseModel")}</p>}
        {recovery.retryAfterSeconds !== null && <span className={s.retryAfter}>{t("recovery.retryAfter").replace("{seconds}", String(recovery.retryAfterSeconds))}</span>}
        <div className={s.actions}>
          {recovery.kind === "unsupported_setting" && onAdjustThinking && (
            <button type="button" className={s.primary} disabled={busy} onClick={onAdjustThinking}>{t("recovery.adjustThinking")}</button>
          )}
          {recovery.candidate && (
            <button type="button" className={s.primary} disabled={busy} onClick={() => void onRetryWithModel(recovery.candidate as ProviderRecoveryModel)}>
              {t("recovery.retryWith").replace("{model}", recovery.candidate.name)}
            </button>
          )}
          {canFallback && <label>
            <input type="checkbox" checked={recovery.automatic} onChange={(event) => onAutomaticChange(event.target.checked)} />
            <span>{t("recovery.automatic")}</span>
          </label>}
        </div>
      </div>
    </section>
  );
}
