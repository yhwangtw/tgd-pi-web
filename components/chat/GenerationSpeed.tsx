"use client";

import { useEffect, useRef, useState } from "react";
import type { AssistantMessage } from "@/lib/types";
import { estimateTextTokens, messageText, TextRateWindow, type GenerationMetrics } from "@/lib/generation-metrics";
import { useI18n } from "@/lib/i18n";
import styles from "./AssistantMessageView.module.css";

export function StreamingSpeed({ message }: { message: AssistantMessage }) {
  const { t } = useI18n();
  const current = useRef(message);
  current.current = message;
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    const window = new TextRateWindow();
    const tick = () => {
      const value = window.sample(estimateTextTokens(messageText(current.current)), performance.now());
      setRate(value === null ? null : Math.round(value));
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, []);
  const last = message.content?.at(-1);
  // Thinking/tool arguments are not visible text throughput.
  const phase = last?.type === "thinking" ? "thinking" : last?.type === "toolCall" ? "tool" : messageText(message) ? "output" : "waiting";
  return <span className={styles.generationSpeed} data-testid="streaming-speed" data-rate-kind="estimated-live" title={t("chat.speedEstimate")}>
    {t(phase === "thinking" ? "chat.speedThinking" : phase === "tool" ? "chat.speedTool" : phase === "output" ? "chat.speedOutput" : "chat.waitingModel")}
    {phase === "output" && rate === null && <> · {t("chat.speedUnavailable")}</>}
    {phase === "output" && rate !== null && <> · {t("chat.speedLive")} {t("chat.speedApprox")} {rate} {t("chat.speedUnit")}</>}
  </span>;
}

export function CompletedSpeed({ metrics }: { metrics: GenerationMetrics }) {
  const { t } = useI18n();
  return <span className={styles.generationSpeed} data-testid="completed-speed" data-rate-kind={metrics.estimated ? "estimated-average" : "provider-average"} title={t("chat.speedAverageHelp")}>
    {metrics.estimated && `${t("chat.speedApprox")} `}{t("chat.speedTokenCount").replace("{count}", metrics.tokens.toLocaleString())} · {t("chat.speedAverage")} {metrics.estimated && `${t("chat.speedApprox")} `}{Math.round(metrics.tokens / metrics.seconds)} {t("chat.speedUnit")}
  </span>;
}
