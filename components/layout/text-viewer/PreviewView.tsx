"use client";

import { useEffect } from "react";
import { MarkdownBody } from "@/components/chat/MarkdownBody";
import { HtmlPreview } from "./HtmlPreview";
import styles from "../TextFileViewer.module.css";

interface Props {
  content: string;
  language: string;
  /** Absolute path of the previewed file — HTML preview renders via URL. */
  filePath?: string;
  revision?: string | number;
  /** Fires after the lazy preview component commits its first rendered frame. */
  onRendered?: () => void;
}

export function PreviewView({ content, language, filePath, revision, onRendered }: Props) {
  useEffect(() => {
    if (language !== "html") onRendered?.();
  }, [content, filePath, language, onRendered]);

  if (language === "html") {
    return <HtmlPreview content={content} filePath={filePath} revision={revision} onRendered={onRendered} />;
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
