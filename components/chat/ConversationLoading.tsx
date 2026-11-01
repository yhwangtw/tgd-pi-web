"use client";

import { useI18n } from "@/lib/i18n";
import styles from "./ChatWindow.module.css";

/** Shared by the conversation's code and data loading states. */
export function ConversationLoading() {
  const { t } = useI18n();
  return (
    <div className={styles.loadingConversation}>
      <div className={styles.skeletonWrapper}>
        <p className={styles.loadingLabel} role="status">{t("chat.loadingConversation")}</p>
        <div aria-hidden="true">{[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="skeleton-line" style={{ width: `${40 + (i % 3) * 20}%`, marginBottom: 10, marginLeft: i % 2 === 0 ? 0 : 60 }} />
        ))}</div>
      </div>
    </div>
  );
}
