"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Check, Copy, Ellipsis, GitFork, Pencil, Reply, RotateCcw } from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import type {
  UserMessage,
  ImageContent,
  TextContent,
} from "@/lib/types";
import styles from "./UserMessageView.module.css";
import { ImageLightbox } from "./ImageLightbox";
import { useI18n } from "@/lib/i18n";
import { MessageBookmarkAction, MessageBookmarkIndicator } from "./MessageBookmarkAction";
import { useMobileActionPlacement } from "@/hooks/use-mobile-action-placement";
import { parseDesignContext } from "@/lib/design-context";

function formatTime(ts?: number, locale: "en" | "zh" = "en"): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const language = locale === "zh" ? "zh-TW" : "en";
  const time = d.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString(language, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}

export function UserMessageView({ message, entryId, onFork, forking, prevAssistantEntryId, onEditRerun, onQuote, isBookmarked = false, onToggleBookmark }: {
  message: UserMessage;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  /** @deprecated superseded by inline edit (onEditRerun); still accepted for compat */
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  /** @deprecated superseded by inline edit (onEditRerun) */
  onEditContent?: (content: string) => void;
  onEditRerun?: (prevAssistantEntryId: string | undefined, newText: string) => void;
  onQuote?: (text: string) => void;
  isBookmarked?: boolean;
  onToggleBookmark?: (entryId: string) => void;
}) {
  const { locale, t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDetailsElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const actionPlacement = useMobileActionPlacement(actionsRef, actionsOpen);

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const designContext = parseDesignContext(content);
  const editRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) return;
    const ta = editRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [editing]);

  const startEdit = () => { setDraft(content); setEditing(true); };
  const commitEdit = () => {
    const text = draft.trim();
    if (!text) return;
    setEditing(false);
    onEditRerun?.(prevAssistantEntryId, text);
  };

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const time = formatTime(message.timestamp, locale);
  const canFork = !!entryId && !!onFork;
  const canEdit = !!prevAssistantEntryId && !!onEditRerun;
  const canBookmark = !!entryId && !!onToggleBookmark;

  const closeActions = useCallback(() => {
    actionsRef.current?.removeAttribute("open");
    setActionsOpen(false);
  }, []);
  useEffect(() => {
    if (!actionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) closeActions();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeActions();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [actionsOpen, closeActions]);

  const copyContent = () => {
    copyText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const quoteContent = () => {
    if (!onQuote) return;
    const selection = window.getSelection();
    const selected = selection?.anchorNode && rootRef.current?.contains(selection.anchorNode)
      ? selection.toString().trim()
      : "";
    onQuote(selected || content);
  };

  return (
    <div
      ref={rootRef}
      data-testid="user-message"
      className={`hover-group ${styles.root}`}
    >
      <div data-testid="user-message-row" className={styles.messageRow}>
        {editing ? (
          <div className={styles.editBox}>
            <textarea
              ref={editRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit(); }
              }}
              className={styles.editTextarea}
              spellCheck={false}
            />
            <div className={styles.editActions}>
              <span className={styles.editHint}>{t("chat.editRerunHint")}</span>
              <button onClick={() => setEditing(false)} className={styles.editCancel}>{t("common.cancel")}</button>
              <button onClick={commitEdit} disabled={!draft.trim()} className={styles.editRerunBtn}>
                <RotateCcw size={11} strokeWidth={2} aria-hidden="true" />
                {t("chat.rerun")}
              </button>
            </div>
          </div>
        ) : (
        <div
          className={`${styles.bubble} ${designContext ? styles.designContextBubble : ""}`}
        >
          {imageBlocks.length > 0 && (
            <div className={content ? styles.imageGrid : styles.imageGridNoMargin}>
              {imageBlocks.map((img, i) => {
                // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
                // pi-ai on-disk format uses flat {data, mimeType} — handle both
                const flat = img as unknown as { data?: string; mimeType?: string };
                const src = img.source
                  ? img.source.type === "base64"
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : img.source.url ?? ""
                  : flat.data
                    ? `data:${flat.mimeType};base64,${flat.data}`
                    : "";
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={src}
                    alt=""
                    className={styles.image}
                    onClick={() => setLightboxSrc(src)}
                    style={{ cursor: "zoom-in" }}
                  />
                );
              })}
            </div>
          )}
          {content && (designContext ? (
            <details className={styles.designContextCard}>
              <summary>
                <span className={styles.designContextHeading}>
                  <strong>{t("chat.designReference")}</strong>
                  <span>{designContext.element}</span>
                </span>
                {designContext.viewport && (
                  <span className={styles.designContextViewport}>
                    {designContext.viewport.width}×{designContext.viewport.height}
                  </span>
                )}
                <span className={styles.designContextDisclosure}>{t("chat.designReferenceDetails")}</span>
              </summary>
              <div className={styles.designContextBody}>
                {designContext.visibleText && (
                  <div className={styles.designContextField}>
                    <span>{t("chat.designTarget")}</span>
                    <strong>{designContext.visibleText}</strong>
                  </div>
                )}
                {designContext.selector && (
                  <div className={styles.designContextField}>
                    <span>{t("chat.designSelector")}</span>
                    <code>{designContext.selector}</code>
                  </div>
                )}
                <pre className={styles.designContextRaw}>{designContext.raw}</pre>
              </div>
            </details>
          ) : (
            <MarkdownBody className="markdown-user-message">{content}</MarkdownBody>
          ))}
          {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
        </div>
        )}

      </div>

      {/* Bottom row: action buttons + timestamp (hidden while editing) */}
      {!editing && (
        <div className={styles.bottomRow}>
          <div className={styles.desktopActionToolbar}>
          <div className={`${styles.actionButtons} ${styles.primaryActions}`}>
            <button
              onClick={copyContent}
              title={t("chat.copyMessage")}
              className={`${styles.actionButton} ${copied ? "text-accent" : "text-dim hover-accent"}`}
            >
              {copied ? (
                <Check size={11} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Copy size={11} strokeWidth={1.8} aria-hidden="true" />
              )}
              {copied ? t("common.copied") : t("common.copy")}
            </button>
            {onQuote && (
              <button type="button" onClick={quoteContent} title={t("chat.quote")} className={`${styles.actionButton} text-dim hover-accent`}>
                <Reply size={11} strokeWidth={1.8} aria-hidden="true" />
                {t("chat.quote")}
              </button>
            )}
            {canBookmark && (
              <MessageBookmarkAction
                isBookmarked={isBookmarked}
                onToggle={() => onToggleBookmark!(entryId!)}
                className={styles.actionButton}
              />
            )}
          </div>
          {(canFork || canEdit) && (
            <div className={`${styles.actionButtons} ${styles.secondaryActions}`}>
              {canEdit && (
                <button
                  onClick={startEdit}
                  title={t("chat.editRerunHint")}
                  className={`${styles.actionButton} text-dim hover-accent`}
                >
                  <Pencil size={11} strokeWidth={1.8} aria-hidden="true" />
                  {t("chat.edit")}
                </button>
              )}
              {canFork && (
                <button
                  onClick={() => { onFork!(entryId!); }}
                  disabled={forking}
                  title={forking ? t("chat.creating") : t("chat.newSession")}
                  className={`${styles.actionButton} ${forking ? "text-accent" : "text-dim hover-accent"}`}
                >
                  <GitFork size={11} strokeWidth={1.8} aria-hidden="true" />
                  {forking ? t("chat.creating") : t("chat.newSession")}
                </button>
              )}
            </div>
          )}
          </div>
          <details ref={actionsRef} className={styles.mobileActionMenu}>
              <summary role="button" title={t("chat.moreActions")} aria-label={t("chat.moreActions")} onClick={() => setActionsOpen(!(actionsRef.current?.open ?? false))}>
                <Ellipsis size={16} strokeWidth={2} aria-hidden="true" />
              </summary>
              <div
                data-testid="user-message-actions"
                data-mobile-action-panel
                className={`${styles.mobileActionPanel} ${actionPlacement === "down" ? styles.mobileActionPanelDown : ""}`}
              >
                <button
                  type="button"
                  onClick={() => { closeActions(); copyContent(); }}
                  className={`${styles.actionButton} ${copied ? "text-accent" : "text-dim hover-accent"}`}
                >
                  {copied ? (
                    <Check size={13} strokeWidth={1.8} aria-hidden="true" />
                  ) : (
                    <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
                  )}
                  {copied ? t("common.copied") : t("common.copy")}
                </button>
                {onQuote && (
                  <button
                    type="button"
                    onClick={() => { closeActions(); quoteContent(); }}
                    className={`${styles.actionButton} text-dim hover-accent`}
                  >
                    <Reply size={13} strokeWidth={1.8} aria-hidden="true" />
                    {t("chat.quote")}
                  </button>
                )}
                {canBookmark && (
                  <MessageBookmarkAction
                    isBookmarked={isBookmarked}
                    onToggle={() => { closeActions(); onToggleBookmark!(entryId!); }}
                    className={styles.actionButton}
                  />
                )}
                {canEdit && (
                  <button
                    onClick={() => { closeActions(); startEdit(); }}
                    className={`${styles.actionButton} text-dim hover-accent`}
                  >
                    <Pencil size={13} strokeWidth={1.8} aria-hidden="true" />
                    {t("chat.edit")}
                  </button>
                )}
                {canFork && (
                  <button
                    onClick={() => { closeActions(); onFork!(entryId!); }}
                    disabled={forking}
                    className={`${styles.actionButton} ${forking ? "text-accent" : "text-dim hover-accent"}`}
                  >
                    <GitFork size={13} strokeWidth={1.8} aria-hidden="true" />
                    {forking ? t("chat.creating") : t("chat.newSession")}
                  </button>
                )}
              </div>
            </details>
          <MessageBookmarkIndicator isBookmarked={canBookmark && isBookmarked} />
          {time && <span className={styles.timestamp}>{time}</span>}
        </div>
      )}
    </div>
  );
}
