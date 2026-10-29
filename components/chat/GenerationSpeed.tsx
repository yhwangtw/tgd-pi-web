"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { UI_ICON_SIZE } from "@/lib/ui-icons";
import type { AssistantMessage } from "@/lib/types";
import { estimateTextTokens, messageText, TextRateWindow, type GenerationMetrics } from "@/lib/generation-metrics";
import { useI18n } from "@/lib/i18n";
import styles from "./AssistantMessageView.module.css";

function formatRate(rate: number, locale: "en" | "zh"): string {
  // Preserve a positive sub-token rate rather than rounding it to a false zero.
  return (rate >= 1 ? Math.round(rate) : rate).toLocaleString(locale === "zh" ? "zh-TW" : "en-US",
    rate < 1 ? { maximumSignificantDigits: 2 } : undefined);
}

function speedTier(rate: number): "slow" | "mid" | "good" | "fast" {
  return rate >= 50 ? "fast" : rate >= 30 ? "good" : rate >= 15 ? "mid" : "slow";
}

export function StreamingSpeed({ message, enabled = true, activity, resetKey }: {
  message?: AssistantMessage | null;
  enabled?: boolean;
  activity?: string;
  resetKey?: string | number | null;
}) {
  const { t, locale } = useI18n();
  const current = useRef(message);
  current.current = message;
  const last = message?.content?.at(-1);
  // Thinking and tool arguments never count as visible-text throughput.
  const phase = last?.type === "thinking" ? "thinking" : last?.type === "toolCall" ? "tool" : message && messageText(message) ? "output" : "waiting";
  const measurable = enabled && (phase === "output" || phase === "waiting");
  const identity = `${resetKey ?? ""}:${message?.provider ?? ""}:${message?.model ?? ""}:${message?.timestamp ?? ""}`;
  const [sample, setSample] = useState<{ identity: string; rate: number | null } | null>(null);
  useEffect(() => {
    if (!measurable) { setSample(null); return; }
    const window = new TextRateWindow();
    const tick = () => {
      // The first frame after reconnect / message change is a baseline only.
      const value = window.sample(current.current ? estimateTextTokens(messageText(current.current)) : 0, performance.now());
      setSample({ identity, rate: value !== null && Number.isFinite(value) && value > 0 ? value : null });
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [identity, measurable]);
  const rate = measurable && phase === "output" && sample?.identity === identity ? sample.rate : null;
  const count = message ? Math.round(estimateTextTokens(messageText(message))) : 0;
  const tier = rate === null ? null : speedTier(rate);
  const rateText = rate === null ? "" : rate.toLocaleString(locale === "zh" ? "zh-TW" : "en-US",
    rate < 0.1 ? { maximumSignificantDigits: 2 } : { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return <span className={`${styles.generationSpeed} ${styles.tokenCount}`} data-testid="streaming-speed"
    data-rate-kind="estimated-live" data-rate-available={rate !== null ? "true" : "false"}
    title={`${activity ? `${activity} · ` : ""}${t("chat.speedEstimate")}`}>
    {phase === "output" && count > 0 && <span className={styles.tokenCountInner} title={t("chat.estimatedTokens")}>
      <ArrowDown size={UI_ICON_SIZE.inline} strokeWidth={1.6} aria-hidden="true" />
      {count.toLocaleString(locale === "zh" ? "zh-TW" : "en-US")}
    </span>}
    {rate !== null ? <span className={styles.tpsBadge} data-speed-tier={tier}
      aria-label={`${t("chat.speedLive")} ${t("chat.speedApprox")} ${rateText} ${t("chat.speedUnit")}`}>
      {t("chat.speedApprox")} {rateText} {t("chat.speedUnit")}
    </span> : <span>{t(phase === "thinking" ? "chat.speedThinking" : phase === "tool" ? "chat.speedTool" : phase === "output" ? "chat.speedUnavailable" : "chat.waitingModel")}</span>}
  </span>;
}

function measuredRate(metrics: GenerationMetrics): number | null {
  const rate = metrics.tokens / metrics.seconds;
  return Number.isFinite(metrics.tokens) && metrics.tokens > 0 && Number.isFinite(metrics.seconds)
    && metrics.seconds > 0 && Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function CompletedSpeed({ metrics }: { metrics: GenerationMetrics }) {
  const { t, locale } = useI18n();
  const rate = measuredRate(metrics);
  if (rate === null) return null;
  return <span className={styles.generationSpeed} data-testid="completed-speed"
    data-rate-kind={metrics.estimated ? "estimated-average" : "provider-average"}
    data-metrics-source={metrics.source ?? "browser"}
    title={t(metrics.estimated ? "chat.speedEstimatedAverageHelp" : "chat.speedAverageHelp")}>
    <span>{metrics.estimated && `${t("chat.speedApprox")} `}{t("chat.speedTokenCount").replace("{count}", metrics.tokens.toLocaleString(locale === "zh" ? "zh-TW" : "en-US"))}</span>{" · "}
    <span className={styles.tpsBadge} data-speed-tier={speedTier(rate)}>
      {t("chat.speedAverage")} {metrics.estimated && `${t("chat.speedApprox")} `}{formatRate(rate, locale)} {t("chat.speedUnit")}
    </span>
  </span>;
}
