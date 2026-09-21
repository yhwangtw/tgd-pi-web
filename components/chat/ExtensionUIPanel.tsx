"use client";

import { useState } from "react";
import type { ExtensionUIState } from "@/hooks/use-extension-ui";
import type { WebExtensionUIResponse, WebExtensionUIWidgetPlacement } from "@/lib/web-extension-ui-types";
import { ArrowUp } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { UserQuestionCard } from "./UserQuestionCard";
import styles from "./ExtensionUIPanel.module.css";

interface Props {
  state: ExtensionUIState;
  onRespond: (response: WebExtensionUIResponse) => Promise<void>;
  onWorkflowCommand?: (message: string) => Promise<boolean>;
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

function visibleStatuses(statuses: ExtensionUIState["statuses"]) {
  return Object.entries(statuses).map(([rawKey, rawText]) => {
    const key = stripTerminalFormatting(rawKey);
    const text = stripTerminalFormatting(rawText);
    return [key, text] as const;
  }).filter(([key, text]) => {
    if (key.toLocaleLowerCase() !== "telegram") return true;
    const normalized = text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    return normalized !== "connected" && normalized !== "telegram connected";
  });
}

export function ExtensionUIPanel({ state, onRespond, onWorkflowCommand, wide = false, questionInTranscript = false }: Props) {
  const first = state.dialogs[0];
  const dialog = questionInTranscript ? undefined : first;
  const hasAboveWidgets = Object.values(state.widgets).some((widget) => widget.placement === "aboveEditor");
  const statuses = visibleStatuses(state.statuses);
  const hasStatuses = statuses.length > 0;
  if (!dialog && !hasAboveWidgets && !hasStatuses) return null;

  return (
    <>
      {(hasAboveWidgets || hasStatuses) && (
        <div className={styles.outer} data-testid="extension-status">
          <div className={`${styles.inner} ${wide ? styles.innerWide : ""}`}>
            <ExtensionWidgets state={state} placement="aboveEditor" bare onWorkflowCommand={onWorkflowCommand} />
            {hasStatuses && (
              <div className={styles.statusRow} role="status">
                {statuses.map(([key, text]) => (
                  <span key={key} className={styles.statusChip}>
                    <span className={styles.statusDot} aria-hidden />
                    <span className={styles.statusKey}>{key}</span>
                    <span>{text}</span>
                  </span>
                ))}
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
          {t("extensionUI.viewQuestion")}<ArrowUp size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function ExtensionWidgets({ state, placement, wide = false, bare = false, onWorkflowCommand }: {
  state: ExtensionUIState;
  placement: WebExtensionUIWidgetPlacement;
  wide?: boolean;
  bare?: boolean;
  onWorkflowCommand?: (message: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const widgets = Object.entries(state.widgets)
    .filter(([, widget]) => widget.placement === placement)
    .map(([key, widget]) => [stripTerminalFormatting(key), widget] as const);
  if (widgets.length === 0) return null;
  const content = (
    <div className={styles.widgets}>
      {widgets.map(([key, widget]) => (key === "Goal" || key === "Plan") && onWorkflowCommand ? (
        <section key={key} className={`${styles.widget} ${styles.workflow}`} aria-label={key} data-testid={`workflow-${key.toLowerCase()}`}>
          <details>
            <summary onPointerDown={event => { if (event.isPrimary && event.button === 0) event.preventDefault(); }}><span className={styles.widgetKey}>{key}</span> {stripTerminalFormatting(widget.lines[0] ?? "").slice(0, 160)}{(widget.lines[0]?.length ?? 0) > 160 ? "…" : ""}</summary>
            <div className={styles.workflowSteps}>{stripTerminalFormatting(widget.lines.slice((widget.lines[0]?.length ?? 0) > 160 ? 0 : 1).join("\n"))}</div>
          </details>
          <div className={styles.workflowActions}>
            {(key === "Goal" ? [
              { command: "/goal pause", label: t("workflow.pause") },
              { command: "/goal resume", label: t("workflow.resume") },
              { command: "/goal", label: t("workflow.manage") },
            ] : [
              { command: "/plan", label: t("workflow.review") },
              { command: "/plan execute", label: t("workflow.execute") },
            ]).map(action => <button key={action.command} type="button" disabled={pendingAction !== null}
              onPointerDown={event => {
                // Preserve composer focus: mobile navigation returning on blur
                // can move this control before pointerup and swallow the click.
                if (event.isPrimary && event.button === 0) event.preventDefault();
              }}
              onClick={async () => {
                setPendingAction(action.command);
                try { await onWorkflowCommand(action.command); } finally { setPendingAction(null); }
              }}>{action.label}</button>)}
          </div>
        </section>
      ) : (
        <section key={key} className={styles.widget} aria-label={key}>
          <span className={styles.widgetKey}>{key}</span>
          <span className={styles.widgetText}>{stripTerminalFormatting(widget.lines.join("\n"))}</span>
        </section>
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
