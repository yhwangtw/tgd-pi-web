"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { useRef, useState } from "react";
import type { ExtensionUIState } from "@/hooks/use-extension-ui";
import type { WorkflowKey, WorkflowVisibility } from "@/hooks/use-workflow-visibility";
import type { WebExtensionUIResponse, WebExtensionUIWidgetPlacement } from "@/lib/web-extension-ui-types";
import { ArrowUp, ListChecks, Target, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { UserQuestionCard } from "./UserQuestionCard";
import styles from "./ExtensionUIPanel.module.css";

interface Props {
  state: ExtensionUIState;
  onRespond: (response: WebExtensionUIResponse) => Promise<void>;
  onWorkflowCommand?: (message: string) => Promise<boolean>;
  sessionId?: string;
  workflowVisibility?: WorkflowVisibility;
  workflowBusy?: boolean;
  workflowPending?: boolean;
  wide?: boolean;
  /** ChatWindow renders all agent questions in its transcript, never over the composer. */
  questionInTranscript?: boolean;
}

/** Strip ANSI SGR sequences, including fragments persisted without the ESC byte. */
export function stripTerminalFormatting(value: string): string {
  return value
    .replaceAll("\u001b", "")
    .replaceAll("\u009b", "[")
    .replace(/\[(?:\d{1,3};)*\d{1,3}m/g, "")
    .trim();
}

function terminalWorkflow(key: string, status: string) {
  return (key === "Goal" && /^(complete|blocked)\b/.test(stripTerminalFormatting(status)))
    || (key === "Plan" && /^complete\b/.test(stripTerminalFormatting(status)));
}

function visibleStatuses(statuses: ExtensionUIState["statuses"]) {
  return Object.entries(statuses).map(([rawKey, rawText]) => {
    const key = stripTerminalFormatting(rawKey);
    const text = stripTerminalFormatting(rawText);
    return [key, text] as const;
  }).filter(([key, text]) => {
    if (terminalWorkflow(key, text)) return false;
    // OpenViking publishes a persistent footer status after every recall.
    // Its healthy counters are useful in a terminal, but in the web composer
    // they look like a memory-injection notice that never goes away. Keep
    // failure states visible so connection and MCP problems remain actionable.
    if (key.toLocaleLowerCase() === "openviking") {
      return !text.startsWith("OV ✓") || text.includes("tools ✗");
    }
    if (key.toLocaleLowerCase() !== "telegram") return true;
    const normalized = text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    return normalized !== "connected" && normalized !== "telegram connected";
  });
}

function hiddenWorkflow(key: string, visibility?: WorkflowVisibility) {
  return (key === "Goal" || key === "Plan") && visibility?.hidden[key] === true;
}

export function WorkflowToolbar({ state, workflowVisibility }: { state: ExtensionUIState; workflowVisibility: WorkflowVisibility }) {
  const { t } = useI18n();
  const keys = (["Goal", "Plan"] as const).filter(key =>
    Object.keys(state.widgets).some(rawKey => stripTerminalFormatting(rawKey) === key)
    && !terminalWorkflow(key, state.statuses[key] ?? ""));
  if (!keys.length) return null;
  return <div className={styles.workflowToolbar} data-workflow-toolbar>
    {keys.map(key => {
      const visible = !workflowVisibility.hidden[key];
      const label = t(key === "Goal" ? visible ? "workflow.hideGoal" : "workflow.showGoal" : visible ? "workflow.hidePlan" : "workflow.showPlan");
      const Icon = key === "Goal" ? Target : ListChecks;
      return <button key={key} type="button" className={styles.workflowToggle}
        ref={element => { workflowVisibility.toolbarRefs.current[key] = element; }}
        aria-label={label} title={label} aria-expanded={visible} aria-controls={workflowVisibility.cardId(key)}
        onPointerDown={event => { if (event.isPrimary && event.button === 0) event.preventDefault(); }}
        onClick={event => workflowVisibility.setHidden(key, visible, event.currentTarget)}>
        <Icon size={UI_ICON_SIZE.control} aria-hidden />
      </button>;
    })}
  </div>;
}

export function ExtensionUIPanel({ state, onRespond, onWorkflowCommand, sessionId, workflowVisibility, workflowBusy, workflowPending, wide = false, questionInTranscript = false }: Props) {
  const { t } = useI18n();
  const first = state.dialogs[0];
  const dialog = questionInTranscript ? undefined : first;
  const hasAboveWidgets = Object.entries(state.widgets).some(([key, widget]) => widget.placement === "aboveEditor" && !hiddenWorkflow(stripTerminalFormatting(key), workflowVisibility) && !terminalWorkflow(stripTerminalFormatting(key), state.statuses[key] ?? ""));
  const statuses = visibleStatuses(state.statuses).filter(([key]) => !hiddenWorkflow(key, workflowVisibility) && !(
    onWorkflowCommand && (key === "Goal" || key === "Plan") && state.widgets[key]?.placement === "aboveEditor"
  ))
    .sort((a, b) => Number(/error|fail|blocked|✗|waiting/i.test(b[1])) - Number(/error|fail|blocked|✗|waiting/i.test(a[1])));
  const hasStatuses = statuses.length > 0;
  if (!dialog && !hasAboveWidgets && !hasStatuses) return null;

  return (
    <>
      {(hasAboveWidgets || hasStatuses) && (
        <div className={styles.outer} data-testid="extension-status">
          <div className={`${styles.inner} ${wide ? styles.innerWide : ""}`}>
            <ExtensionWidgets key={sessionId ?? "unsaved"} state={state} placement="aboveEditor" bare onWorkflowCommand={onWorkflowCommand} workflowVisibility={workflowVisibility} workflowBusy={workflowBusy} workflowPending={workflowPending} />
            {hasStatuses && (
              <div className={styles.statusRow} role="status">
                <span className={styles.statusChip}>
                  <span className={styles.statusKey}>{statuses[0][0]}</span><span>{statuses[0][1]}</span>
                </span>
                {statuses.length > 1 && <details className={styles.extraStatuses}>
                  <summary>{t("extensionUI.moreStatuses")} · {statuses.length - 1}</summary>
                  {statuses.slice(1).map(([key, text]) => <div key={key}><strong>{key}</strong> {text}</div>)}
                </details>}
              </div>
            )}
          </div>
        </div>
      )}
      {dialog && (
        <div data-testid="extension-question">
          <UserQuestionCard key={dialog.id} request={dialog} pendingCount={state.dialogs.length} onRespond={onRespond} />
        </div>
      )}
    </>
  );
}

export function PendingQuestionNotice({ onShow, wide = false }: { onShow: () => void; wide?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={styles.outer} data-testid="pending-question-notice">
      <div className={`${styles.inner} ${wide ? styles.innerWide : ""} ${styles.questionNotice}`}>
        <span role="status">{t("extensionUI.pendingAnswer")}</span>
        <button type="button" onPointerDown={(event) => {
          // Keep the composer focused until click is delivered. Blurring it on
          // pointerdown restores the mobile nav and moves this button before
          // pointerup, swallowing the user's first click. onShow then moves
          // focus to the revealed question; keyboard activation is unchanged.
          if (event.isPrimary && event.button === 0) event.preventDefault();
        }} onClick={onShow}>
          {t("extensionUI.viewQuestion")}<ArrowUp size={UI_ICON_SIZE.compact} aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function ExtensionWidgets({ state, placement, wide = false, bare = false, onWorkflowCommand, workflowVisibility, workflowBusy = false, workflowPending = false }: {
  state: ExtensionUIState;
  placement: WebExtensionUIWidgetPlacement;
  wide?: boolean;
  bare?: boolean;
  onWorkflowCommand?: (message: string) => Promise<boolean>;
  workflowVisibility?: WorkflowVisibility;
  workflowBusy?: boolean;
  workflowPending?: boolean;
}) {
  const { t } = useI18n();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const widgets = Object.entries(state.widgets)
    .filter(([key, widget]) => widget.placement === placement && !hiddenWorkflow(stripTerminalFormatting(key), workflowVisibility) && !terminalWorkflow(stripTerminalFormatting(key), state.statuses[key] ?? ""))
    .map(([key, widget]) => [stripTerminalFormatting(key), widget] as const);
  if (widgets.length === 0) return null;
  const content = (
    <div className={styles.widgets}>
      {widgets.map(([key, widget]) => (key === "Goal" || key === "Plan") && onWorkflowCommand ? (
        <section key={key} id={workflowVisibility?.cardId(key)} className={`${styles.widget} ${styles.workflow}`} aria-label={key} data-testid={`workflow-${key.toLowerCase()}`}>
          <div className={styles.workflowHeader}>
            <details>
            <summary onPointerDown={event => { if (event.isPrimary && event.button === 0) event.preventDefault(); }}><span className={styles.widgetKey}>{key}</span><span className={styles.workflowState}>{stripTerminalFormatting(state.statuses[key] ?? "")}</span> {stripTerminalFormatting(widget.lines[0] ?? "").slice(0, 160)}{(widget.lines[0]?.length ?? 0) > 160 ? "…" : ""}</summary>
            <div className={styles.workflowSteps}>{stripTerminalFormatting(widget.lines.slice((widget.lines[0]?.length ?? 0) > 160 ? 0 : 1).join("\n"))}</div>
            </details>
          {workflowVisibility && <button type="button" className={styles.workflowHide}
            ref={element => { workflowVisibility.cardRefs.current[key as WorkflowKey] = element; }}
            aria-label={t(key === "Goal" ? "workflow.hideGoal" : "workflow.hidePlan")}
            title={t("workflow.hideHint")}
            onPointerDown={event => { if (event.isPrimary && event.button === 0) event.preventDefault(); }}
            onClick={event => workflowVisibility.setHidden(key, true, event.currentTarget)}><X size={UI_ICON_SIZE.control} aria-hidden /></button>}
          </div>
          <div className={styles.workflowActions}>
            {(key === "Goal" ? [
              ...(state.statuses.Goal?.startsWith("active") ? [{ command: "/goal pause", label: t("workflow.pause") }] : []),
              ...(state.statuses.Goal?.startsWith("paused") ? [{ command: "/goal resume", label: t("workflow.resume") }] : []),
              { command: "/goal", label: t("workflow.manage") },
            ] : [
              { command: "/plan", label: t("workflow.review") },
              ...(state.statuses.Plan?.startsWith("ready") ? [{ command: "/plan execute", label: t("workflow.execute") }] : []),
              { command: "/plan exit", label: t("workflow.exitPlan") },
            ]).map(action => <button key={action.command} type="button" disabled={workflowPending || pendingAction !== null || (workflowBusy && key === "Plan" && action.command !== "/plan")}
              onPointerDown={event => {
                // Preserve composer focus: mobile navigation returning on blur
                // can move this control before pointerup and swallow the click.
                if (event.isPrimary && event.button === 0) event.preventDefault();
              }}
              onClick={async () => {
                if (pendingRef.current) return;
                pendingRef.current = true;
                setActionError(null);
                setPendingAction(action.command);
                try { await onWorkflowCommand(action.command); }
                catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
                finally { pendingRef.current = false; setPendingAction(null); }
              }}>{action.label}</button>)}
          </div>
          {actionError && <span role="alert">{actionError}</span>}
        </section>
      ) : (
        <details key={key} className={styles.widget} aria-label={key}>
          <summary className={styles.widgetKey} onPointerDown={event => {
            // Keep mobile composer focus until the disclosure activates; a
            // returning navigation bar must not move it before pointerup.
            if (event.isPrimary && event.button === 0) event.preventDefault();
          }}>{key}</summary>
          <span className={styles.widgetText}>{stripTerminalFormatting(widget.lines.join("\n"))}</span>
        </details>
      ))}
    </div>
  );
  if (bare) return content;
  return (
    <div className={styles.outer}>
      <div className={`${styles.inner} ${wide ? styles.innerWide : ""}`}>{content}</div>
    </div>
  );
}
