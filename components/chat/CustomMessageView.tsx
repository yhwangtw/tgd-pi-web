"use client";

import type { CustomMessage } from "@/lib/types";
import { MarkdownBody } from "./MarkdownBody";
import { useI18n } from "@/lib/i18n";
import s from "./CustomMessageView.module.css";

function contentText(message: CustomMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("\n");
}

/** Safe Web fallback for Pi TUI custom renderers: preserves content and details without executing terminal renderer code. */
export function CustomMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  if (!message.display) return null;
  const text = contentText(message);
  return <section className={s.root} data-custom-type={message.customType}>
    <header><span>{t("extensionUI.extension")}</span><strong>{message.customType}</strong></header>
    {text && <MarkdownBody>{text}</MarkdownBody>}
    {message.details !== undefined && <details><summary>{t("common.details")}</summary><pre>{JSON.stringify(message.details, null, 2)}</pre></details>}
  </section>;
}
