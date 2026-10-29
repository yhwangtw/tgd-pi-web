"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { ChevronDown, Clock3, LoaderCircle, RefreshCw } from "lucide-react";
import { runProgressAttention } from "@/lib/agent-run-state";
import type { AgentPhase, RunProgressState } from "@/hooks/use-agent-session-types";
import { useI18n, type MsgKey } from "@/lib/i18n";
import type { activeToolDetails } from "@/lib/tool-preview";
import type { ChildActivity } from "@/lib/tool-activity";
import { formatRunDuration } from "./ElapsedTime";
import styles from "./ChatWindow.module.css";

export function phaseLabel(phase: AgentPhase, translate?: (key: MsgKey) => string): string {
  if (!translate) {
    if (phase?.kind === "running_tools") {
      const names = phase.tools.map((tool) => tool.label ?? tool.name);
      if (names.length === 0) return "Running tool...";
      if (names.length === 1) return `Running ${names[0]}...`;
      if (names.length <= 3) return `Running ${names.join(", ")}...`;
      return `Running ${names.slice(0, 2).join(", ")} (+${names.length - 2})...`;
    }
    if (phase?.kind === "stopping") return "Stopping…";
    if (phase?.kind === "waiting_model") return "Waiting for model...";
    if (phase?.kind === "preparing_tools") return "Preparing tool...";
    if (phase?.kind === "writing") return "Writing...";
    return phase?.kind === "thinking" ? "Thinking..." : "Waiting for model...";
  }
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((tool) => tool.label ?? tool.name);
    const running = translate("chat.runningStatus");
    if (names.length === 0) return `${running} tool…`;
    if (names.length === 1) return `${running} ${names[0]}…`;
    if (names.length <= 3) return `${running} ${names.join(", ")}…`;
    return `${running} ${names.slice(0, 2).join(", ")} (+${names.length - 2})…`;
  }
  if (phase?.kind === "stopping") return translate("chat.stopping");
  if (phase?.kind === "waiting_model") return translate("chat.waitingModel");
  if (phase?.kind === "preparing_tools") return translate("chat.speedTool");
  if (phase?.kind === "writing") return translate("chat.speedOutput");
  return translate(phase?.kind === "thinking" ? "chat.thinkingStatus" : "chat.waitingModel");
}

export type RunStatusState = "normal" | "delayed" | "stalled" | "reconnecting" | "connecting";

export function runStatusState(progress: RunProgressState): RunStatusState {
  return progress.connection !== "connected" ? progress.connection : progress.attention;
}

// Update only this small monitor; the history and composer don't tick with it.
function useRunClock(progress: RunProgressState, lastProgressAtRef?: RefObject<number>) {
  const [clock, setClock] = useState(() => {
    const now = Date.now();
    return { now, lastProgressAt: progress.lastProgressAt ?? now - progress.idleSeconds * 1000 };
  });
  useEffect(() => {
    const fallback = progress.lastProgressAt ?? Date.now() - progress.idleSeconds * 1000;
    const update = () => setClock({ now: Date.now(), lastProgressAt: lastProgressAtRef?.current ?? fallback });
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [lastProgressAtRef, progress.lastProgressAt, progress.idleSeconds]);
  return clock;
}

const childStateLabel: Record<ChildActivity["state"], MsgKey> = {
  pending: "chat.toolPending", running: "chat.runningTool", completed: "chat.workComplete",
  failed: "chat.toolFailed", detached: "chat.runChildDetached",
};

export function RunStatus({ phase, progress, startedAt, lastProgressAtRef, tools = [], onRevealTool, wide = false }: {
  phase: AgentPhase;
  progress: RunProgressState;
  startedAt: number | null;
  lastProgressAtRef?: RefObject<number>;
  tools?: ReturnType<typeof activeToolDetails>;
  onRevealTool?: (id: string) => void;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const clock = useRunClock(progress, lastProgressAtRef);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const idle = Math.max(0, Math.floor((clock.now - clock.lastProgressAt) / 1000));
  const state = runStatusState({ ...progress, attention: runProgressAttention(idle, phase) });
  const quiet = state === "delayed" || state === "stalled";
  const unconfirmed = quiet || state === "reconnecting" || state === "connecting";
  const reportedPhase = phase?.kind === "running_tools" && phase.tools.length > 1
    ? t("chat.runToolCount").replace("{count}", String(phase.tools.length)) : phaseLabel(phase, t);
  const label = unconfirmed ? t("chat.runLastState").replace("{state}", reportedPhase) : reportedPhase;
  const connection = state === "connecting" ? t("chat.connecting")
    : state === "reconnecting" ? t("chat.reconnecting")
    : quiet ? t("chat.runQuiet") : t("chat.runConnected");
  const Icon = state === "reconnecting" || state === "connecting" ? RefreshCw : quiet ? Clock3 : LoaderCircle;
  const elapsed = (start: number) => formatRunDuration(Math.max(0, Math.floor((clock.now - start) / 1000)));
  const reveal = (id: string) => { setExpanded(false); onRevealTool?.(id); };
  const first = tools[0];
  return (
    <div
      className={`${styles.runStatus} ${wide ? styles.runStatusWide : ""}`}
      data-testid="run-monitor"
      data-progress-state={state}
      data-run-phase={phase?.kind ?? "waiting_model"}
      data-tone={state === "reconnecting" ? "warning" : "neutral"}
      role="group"
      aria-label={t("chat.runMonitor")}
      onKeyDown={event => {
        if (event.key === "Escape" && expanded) { event.stopPropagation(); setExpanded(false); toggleRef.current?.focus(); }
      }}
    >
      <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{label} · {connection}</span>
      <div className={styles.runStatusVisual} aria-live="off">
        <div className={styles.runStatusHeading}>
          <Icon size={UI_ICON_SIZE.compact} aria-hidden="true"
            className={`${styles.runStatusIcon} ${state === "normal" || state === "reconnecting" || state === "connecting" ? styles.runStatusSpin : ""}`} />
          <span className={styles.runStatusMessage}>{label}</span>
          {first?.preview && <button type="button" className={styles.runStatusToolPreview}
            disabled={!first.canReveal || !onRevealTool} onClick={() => reveal(first.id)}
            aria-label={t("chat.runRevealTool").replace("{tool}", first.label ?? first.name)} data-testid="run-tool-preview">
            {first.preview}
          </button>}
        </div>
        <div className={styles.runStatusMeta}>
          {startedAt != null && Number.isFinite(startedAt) && <span className={styles.runStatusElapsed} data-testid="run-status-elapsed">
            {t("chat.runElapsed").replace("{time}", elapsed(startedAt))}
          </span>}
          <span className={styles.runStatusLastProgress} data-testid="run-last-progress">
            {t("chat.runLastProgress").replace("{time}", formatRunDuration(idle))}
          </span>
        </div>
        <button ref={toggleRef} type="button" className={styles.runStatusToggle} aria-expanded={expanded} aria-controls={detailsId}
          aria-label={t(expanded ? "chat.runHideDetails" : "chat.runShowDetails")} onClick={() => setExpanded(value => !value)}>
          <ChevronDown size={UI_ICON_SIZE.compact} aria-hidden="true" />
        </button>
        {expanded && <div id={detailsId} className={styles.runStatusDetails} data-testid="run-details">
          <p data-testid="run-connection">{connection}</p>
          <p className={styles.runStatusHint}>{t("chat.runQuietHint")}</p>
          {tools.length > 0 && <ul className={styles.runStatusTools}>
            {tools.map(tool => <li key={tool.id} data-testid="run-tool-row" data-active-tool={tool.id}>
              <div className={styles.runStatusToolHeading}>
                <button type="button" disabled={!tool.canReveal || !onRevealTool} onClick={() => reveal(tool.id)}
                  aria-label={t("chat.runRevealTool").replace("{tool}", tool.label ?? tool.name)}>{tool.label ?? tool.name}</button>
                <span>{t(unconfirmed ? "chat.runAwaitingProgress" : "chat.runningTool")}</span>
                {typeof tool.startedAt === "number" && Number.isFinite(tool.startedAt) && <span data-testid="run-tool-elapsed">{t("chat.runStepElapsed").replace("{time}", elapsed(tool.startedAt))}</span>}
              </div>
              {tool.target && <code className={styles.runStatusTarget}>{tool.target}</code>}
              {tool.children && tool.children.length > 0 && <ul className={styles.runStatusChildren} aria-label={t("chat.runChildren")}>
                {tool.children.map(child => <li key={child.id} data-child-state={child.state}>
                  <span>{child.label}</span>
                  <span>{t(childStateLabel[child.state])}</span>
                  {child.target && <code>{child.target}</code>}
                </li>)}
              </ul>}
              {tool.name === "subagent" && !tool.children?.length && <p className={styles.runStatusHint}>{t("chat.runChildrenPending")}</p>}
            </li>)}
          </ul>}
        </div>}
      </div>
    </div>
  );
}
