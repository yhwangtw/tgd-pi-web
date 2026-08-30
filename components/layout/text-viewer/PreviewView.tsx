"use client";

import { useEffect } from "react";
import { MarkdownBody } from "@/components/chat/MarkdownBody";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { useI18n } from "@/lib/i18n";
import styles from "../TextFileViewer.module.css";

interface Props {
  content: string;
  language: string;
  /** Absolute path of the previewed file — HTML preview renders via URL. */
  filePath?: string;
  /** Fires after the lazy preview component commits its first rendered frame. */
  onRendered?: () => void;
}

export function PreviewView({ content, language, filePath, onRendered }: Props) {
  const { t } = useI18n();
  useEffect(() => {
    onRendered?.();
  }, [content, filePath, language, onRendered]);

  if (language === "html" && filePath) {
    // src (not srcDoc) so the browser streams the document itself — HTML
    // preview works at any size, independent of the text-preview cap.
    // Same sandbox as before: scripts run, no same-origin access.
    return (
      <iframe
        src={`/api/files/${encodeFilePathForApi(filePath)}?type=raw`}
        sandbox="allow-scripts"
        className={styles.htmlPreview}
        title={t("files.htmlPreview")}
      />
    );
  }
  if (language === "html") {
    return (
      <iframe
        srcDoc={content}
        sandbox="allow-scripts"
        className={styles.htmlPreview}
        title={t("files.htmlPreview")}
      />
    );
  }
  if (language === "markdown") {
    // Same renderer as chat messages — math, mermaid, code highlighting,
    // table wrappers, and external-link handling all come along for free.
    return (
      <div className={styles.markdownPreview}>
        <MarkdownBody className="markdown-file-preview" allowSafeHtml sourceFilePath={filePath}>{content}</MarkdownBody>
      </div>
    );
  }
  return null;
}
