"use client";

import { memo, useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import styles from "./BashBlock.module.css";
import { useI18n } from "@/lib/i18n";

interface Props {
  command: string;
  output: string;
  /** true while the command streams — shows spinner + abort */
  running?: boolean;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  onAbort?: () => void;
}

/**
 * Terminal pane for direct bash execution (the `!` input prefix).
 * Renders both the live streaming run and the persisted bashExecution
 * message from the session file.
 */
export const BashBlock = memo(function BashBlock({ command, output, running, exitCode, cancelled, truncated, onAbort }: Props) {
  const { t } = useI18n();
  const outputRef = useRef<HTMLPreElement | null>(null);

  // Follow the output while streaming
  useEffect(() => {
    if (running && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, running]);

  const status = running
    ? null
    : cancelled
      ? { label: t("bash.cancelled"), tone: styles.badgeWarn }
      : exitCode === 0 || exitCode === undefined || exitCode === null
        ? { label: "exit 0", tone: styles.badgeOk }
        : { label: `exit ${exitCode}`, tone: styles.badgeErr };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.prompt} aria-hidden>$</span>
        <span className={styles.command} title={command}>{command}</span>
        {running ? (
          <>
            <LoaderCircle size={12} strokeWidth={2.5} className={styles.spinner} aria-label={t("bash.running")} />
            {onAbort && (
              <button onClick={onAbort} className={styles.abortButton}>
                {t("bash.cancel")}
              </button>
            )}
          </>
        ) : (
          status && <span className={`${styles.badge} ${status.tone}`}>{status.label}</span>
        )}
        {truncated && !running && <span className={styles.truncated}>{t("bash.truncated")}</span>}
      </div>
      {(output || running) && (
        <pre ref={outputRef} className={styles.output}>{output || "…"}</pre>
      )}
    </div>
  );
});
