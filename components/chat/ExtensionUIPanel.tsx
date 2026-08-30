"use client";

import type { ExtensionUIState } from "@/hooks/use-extension-ui";
import type { WebExtensionUIResponse, WebExtensionUIWidgetPlacement } from "@/lib/web-extension-ui-types";
import { UserQuestionCard } from "./UserQuestionCard";
import styles from "./ExtensionUIPanel.module.css";

interface Props {
  state: ExtensionUIState;
  onRespond: (response: WebExtensionUIResponse) => Promise<void>;
  wide?: boolean;
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

export function ExtensionUIPanel({ state, onRespond, wide = false }: Props) {
  const dialog = state.dialogs[0];
  const hasAboveWidgets = Object.values(state.widgets).some((widget) => widget.placement === "aboveEditor");
  const statuses = visibleStatuses(state.statuses);
  const hasStatuses = statuses.length > 0;
  if (!dialog && !hasAboveWidgets && !hasStatuses) return null;

  return (
    <>
      {(hasAboveWidgets || hasStatuses) && (
        <div className={styles.outer} data-testid="extension-status">
          <div className={`${styles.inner} ${wide ? styles.innerWide : ""}`}>
            <ExtensionWidgets state={state} placement="aboveEditor" bare />
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
          <UserQuestionCard request={dialog} pendingCount={state.dialogs.length} onRespond={onRespond} />
        </div>
      )}
    </>
  );
}

export function ExtensionWidgets({ state, placement, wide = false, bare = false }: {
  state: ExtensionUIState;
  placement: WebExtensionUIWidgetPlacement;
  wide?: boolean;
  bare?: boolean;
}) {
  const widgets = Object.entries(state.widgets)
    .filter(([, widget]) => widget.placement === placement)
    .map(([key, widget]) => [stripTerminalFormatting(key), widget] as const);
  if (widgets.length === 0) return null;
  const content = (
    <div className={styles.widgets}>
      {widgets.map(([key, widget]) => (
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
