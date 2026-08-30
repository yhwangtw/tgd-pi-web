"use client";

import React from "react";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import styles from "./ErrorBoundary.module.css";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

function DefaultErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className={styles.container} role="alert">
      <AlertTriangle className={styles.icon} size={32} strokeWidth={1.6} aria-hidden="true" />
      <div className={styles.title}>{t("errorBoundary.title")}</div>
      <div className={styles.message}>{error?.message ?? t("errorBoundary.unexpected")}</div>
      <div className={styles.actions}>
        <button type="button" onClick={onRetry} className={styles.retryBtn}>
          {t("errorBoundary.retry")}
        </button>
        <button type="button" onClick={() => window.location.reload()} className={styles.reloadBtn}>
          {t("errorBoundary.reload")}
        </button>
      </div>
    </div>
  );
}

/**
 * Catches unhandled render errors in its subtree and shows a recovery UI
 * instead of a blank white page.  The user can retry the failed subtree
 * or reload the entire page.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log to console in dev; in prod you'd send to an error-reporting service.
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return <DefaultErrorFallback error={this.state.error} onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}
