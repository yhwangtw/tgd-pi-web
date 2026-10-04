"use client";

import { useEffect, useRef, useState } from "react";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { isolatedPreviewDocument } from "@/lib/preview-policy";
import { useI18n } from "@/lib/i18n";
import styles from "./HtmlPreview.module.css";

interface PreviewState {
  key: string;
  status: "loading" | "ready" | "error";
  document?: string;
  warnings?: string[];
  error?: string;
}

export function HtmlPreview({ filePath, content, revision, onRendered }: {
  filePath?: string; content: string; revision?: string | number; onRendered?: () => void;
}) {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const key = `${filePath ?? "inline"}:${revision ?? content}:${attempt}`;
  const [state, setState] = useState<PreviewState>({ key, status: "loading" });
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  const activeKey = useRef(key);
  activeKey.current = key;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ key, status: "loading" });
    timer.current = setTimeout(() => {
      controller.abort();
      if (activeKey.current === key) setState({ key, status: "error", error: t("files.previewTimeout") });
    }, 15000);
    const load = async () => {
      try {
        let html = content;
        let warnings: string[] = [];
        if (filePath) {
          const response = await fetch(`/api/files/${encodeFilePathForApi(filePath)}?type=html-preview`, { signal: controller.signal, cache: "no-store" });
          if (!response.ok) {
            const label = response.status === 404 ? "files.previewMissing" : response.status === 403 ? "files.previewDenied" : response.status === 413 ? "files.previewTooLarge" : "files.previewFailed";
            throw new Error(t(label));
          }
          const bundle = await response.json() as { html: string; warnings: string[] };
          if (typeof bundle.html !== "string") throw new Error(t("files.previewFailed"));
          html = bundle.html;
          warnings = Array.isArray(bundle.warnings) ? bundle.warnings : [];
        }
        if (controller.signal.aborted || activeKey.current !== key) return;
        setState({ key, status: "loading", document: isolatedPreviewDocument(html, !!filePath), warnings });
      } catch (error) {
        if (controller.signal.aborted || activeKey.current !== key) return;
        if (timer.current) clearTimeout(timer.current);
        setState({ key, status: "error", error: error instanceof Error ? error.message : t("files.previewFailed") });
      }
    };
    void load();
    return () => { controller.abort(); if (timer.current) clearTimeout(timer.current); };
  }, [key, content, filePath, t]);

  const current = state.key === key ? state : { key, status: "loading" as const };
  return <div className={styles.root} aria-busy={current.status === "loading"}>
    <div className={styles.toolbar}>
      {current.status === "loading" && <span role="status">{t("files.renderingPreview")}</span>}
      <button type="button" onClick={() => setAttempt((value) => value + 1)}>{t(current.status === "error" ? "files.retryPreview" : "files.reloadPreview")}</button>
    </div>
    {current.status === "error" && <div role="alert" className={styles.feedback}>{current.error}</div>}
    {!!current.warnings?.length && <details className={styles.feedback}>
      <summary>{t("files.previewResourcesSkipped")}</summary>
      <ul>{current.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details>}
    {current.document && current.status !== "error" && <iframe
      key={key}
      srcDoc={current.document}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={t("files.htmlPreview")}
      className={styles.frame}
      onLoad={() => {
        if (activeKey.current !== key) return;
        if (timer.current) clearTimeout(timer.current);
        setState((value) => value.key === key ? { ...value, status: "ready" } : value);
        onRenderedRef.current?.();
      }}
      onError={() => {
        if (activeKey.current !== key) return;
        if (timer.current) clearTimeout(timer.current);
        setState({ key, status: "error", error: t("files.previewFailed") });
      }}
    />}
  </div>;
}
