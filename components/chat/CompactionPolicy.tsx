"use client";

import { ChevronDown, Shrink, TriangleAlert } from "lucide-react";
import { UI_ICON_SIZE } from "@/lib/ui-icons";
import { useI18n } from "@/lib/i18n";
import { compactionThreshold, type CompactionContextUsage, type ResolvedCompactionSettings } from "@/lib/compaction-policy";
import frame from "./CompactionStatus.module.css";
import styles from "./CompactionPolicy.module.css";

export function CompactionPolicy({ usage, contextWindow, settings, wide, busy, onCompact, variant = "controls" }: {
  usage: CompactionContextUsage | null;
  contextWindow?: number;
  settings: ResolvedCompactionSettings | null;
  wide?: boolean;
  busy: boolean;
  onCompact: () => Promise<void>;
  variant?: "controls" | "pressure";
}) {
  const { t } = useI18n();
  // Saved conversations can expose model capacity before any runtime usage exists.
  const threshold = compactionThreshold(usage ?? (contextWindow ? { contextWindow, percent: null, tokens: null } : null), settings);
  if (!threshold || !settings || (variant === "pressure" && !threshold.exceeded)) return null;
  const percent = (value: number) => `${Number(value.toFixed(1))}%`;
  return <div className={variant === "pressure" ? frame.outer : undefined} onPointerDown={event => {
    // Keep the mobile dock still until a manual compaction button receives click.
    if ((event.target as HTMLElement).closest("button") && document.activeElement instanceof HTMLTextAreaElement) event.preventDefault();
  }}>
    <div className={`${frame.panel} ${wide ? frame.panelWide : ""} ${styles.panel} ${variant === "controls" ? styles.controlPanel : ""} ${variant === "pressure" ? styles.warning : ""}`} data-testid={variant === "pressure" ? "compaction-pressure" : "compaction-policy-details"} data-pressure={threshold.exceeded}>
      <details open={variant === "controls" || undefined}>
        <summary>
          {threshold.exceeded ? <TriangleAlert size={UI_ICON_SIZE.inline} aria-hidden /> : <Shrink size={UI_ICON_SIZE.inline} aria-hidden />}
          <span>{t("compact.context").replace("{percent}", usage?.percent == null ? "—" : percent(usage.percent))}</span>
          <span className={styles.mode}>{settings.enabled
            ? t("compact.autoThreshold").replace("{percent}", `≈${percent(threshold.percent)}`)
            : t("compact.manualMode")}</span>
          <ChevronDown className={styles.chevron} size={UI_ICON_SIZE.inline} aria-hidden />
        </summary>
        <p>{settings.enabled
          ? t("compact.thresholdRule").replace("{tokens}", threshold.tokens.toLocaleString())
          : t("compact.disabledHint")}</p>
        <p>{t("compact.tokenPolicy").replace("{reserve}", settings.reserveTokens.toLocaleString()).replace("{keep}", settings.keepRecentTokens.toLocaleString())}</p>
        <p>{t("compact.manualHint")}</p>
      </details>
      {variant === "pressure" && <button type="button" disabled={busy} onClick={() => void onCompact()}>{t("chat.compactNow")}</button>}
    </div>
  </div>;
}
