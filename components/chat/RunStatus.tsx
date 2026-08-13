"use client";

import { useEffect, useState } from "react";
import { Clock3, ClockAlert, LoaderCircle, RefreshCw } from "lucide-react";
import type { AgentPhase, RunProgressState } from "@/hooks/use-agent-session-types";
import { useI18n, type MsgKey } from "@/lib/i18n";
import styles from "./ChatWindow.module.css";

export function phaseLabel(phase: AgentPhase, translate?: (key: MsgKey) => string): string {
  if (!translate) {
    if (phase?.kind === "running_tools") {
      const names = phase.tools.map((tool) => tool.name);
      if (names.length === 0) return "Running tool...";
      if (names.length === 1) return `Running ${names[0]}...`;
      if (names.length <= 3) return `Running ${names.join(", ")}...`;
      return `Running ${names.slice(0, 2).join(", ")} (+${names.length - 2})...`;
    }
    if (phase?.kind === "waiting_model") return "Waiting for model...";
    return "Thinking...";
  }
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((tool) => tool.name);
    const running = translate("chat.runningStatus");
    if (names.length === 0) return `${running} tool…`;
    if (names.length === 1) return `${running} ${names[0]}…`;
    if (names.length <= 3) return `${running} ${names.join(", ")}…`;
    return `${running} ${names.slice(0, 2).join(", ")} (+${names.length - 2})…`;
  }
  if (phase?.kind === "waiting_model") return translate("chat.waitingModel");
  return translate("chat.thinkingStatus");
}

export type RunStatusState = "normal" | "delayed" | "stalled" | "reconnecting";

export function runStatusState(progress: RunProgressState): RunStatusState {
  return progress.connection === "reconnecting" ? "reconnecting" : progress.attention;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const label = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  return <span className={styles.runStatusElapsed}>· {label}</span>;
}

export function RunStatus({
  phase,
  progress,
  startedAt,
}: {
  phase: AgentPhase;
  progress: RunProgressState;
  startedAt: number | null;
}) {
  const { t } = useI18n();
  const state = runStatusState(progress);
  const toolRun = phase?.kind === "running_tools";
  const label = state === "reconnecting"
    ? t("chat.reconnecting")
    : state === "stalled"
      ? t("chat.takingLonger")
      : state === "delayed"
        ? t(toolRun ? "chat.toolStillWorking" : "chat.modelStillWorking")
        : phaseLabel(phase, t);
  const Icon = state === "reconnecting"
    ? RefreshCw
    : state === "stalled"
      ? ClockAlert
      : state === "delayed"
        ? Clock3
        : LoaderCircle;

  return (
    <div
      className={styles.runStatus}
      data-progress-state={state}
      data-tone={state === "reconnecting" ? "warning" : "neutral"}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className={styles.srOnly}>{label}</span>
      <span className={styles.runStatusVisual} aria-hidden="true">
        <Icon
          size={14}
          strokeWidth={state === "normal" ? 2.4 : 2}
          className={`${styles.runStatusIcon} ${state === "normal" || state === "reconnecting" ? styles.runStatusSpin : ""}`}
        />
        <span className={styles.runStatusMessage}>{label}</span>
        {startedAt && <Elapsed since={startedAt} />}
      </span>
    </div>
  );
}
