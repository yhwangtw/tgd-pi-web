"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo, useImperativeHandle, useId, forwardRef, memo, KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  ArrowRight,
  LogOut,
  Ghost,
  FileText,
  Paperclip,
  Maximize2,
  Minimize2,
  RefreshCw,
  Shrink,
  SlidersHorizontal,
  Sparkles,
  Square,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { COMPOSITION_END_ENTER_GRACE_MS, buildSlashItems, type ThinkingLevelOption } from "./chat-input-constants";
import { SlashMenu, filterSlashItems } from "./SlashMenu";
import { clearDraft, loadHistory, saveHistory } from "@/lib/composer-persistence";
import { useComposerDraft } from "@/hooks/useComposerDraft";
import { useFileAttachments } from "@/hooks/useFileAttachments";
import { shouldFencePaste, fencePaste } from "@/lib/paste-fence";
import { showToast } from "@/hooks/useToast";
import { FileMentionMenu, type FileMentionItem } from "./FileMentionMenu";
import { encodeFilePathForApi, joinFilePath } from "@/lib/file-paths";
import { usePrompts } from "@/hooks/usePrompts";
import { ModelSelector } from "./ModelSelector";
import { ThinkingSelector } from "./ThinkingSelector";
import { ToolPresetSelector } from "./ToolPresetSelector";
import type { ToolCatalogEntry, ToolSelectionMode } from "@/lib/tool-selection";
import { ScrollFollowSelector } from "./ScrollFollowSelector";
import { useChatInputControls } from "@/hooks/useChatInputControls";
import { useWorkflowCommand } from "@/hooks/use-workflow-command";
import styles from "./ChatInput.module.css";
import { useI18n } from "@/lib/i18n";
import { extractComposerMentions, removeComposerMention, type ComposerMention } from "@/lib/composer-context";
import { loadStreamingSendMode, resolveStreamingSendMode, saveStreamingSendMode, type StreamingSendMode } from "@/lib/composer-mode";
import { requestOpenFile } from "@/lib/file-links";
import type { ModelCatalogEntry } from "@/lib/model-catalog-types";
import type { ModelCatalogDiagnostic, ModelCatalogStatus } from "@/hooks/use-model-catalog";
import { ScreenshotButton } from "./ScreenshotButton";
import { DialogShell } from "@/components/ui/DialogShell";
import { beginComposerSubmission, hasPendingComposerSubmission, restoreComposerSubmission, sameSubmissionImages, failComposerSubmission, removeComposerSubmission, useComposerSubmissions, type ComposerSubmission } from "@/lib/composer-submissions";
import { useComposerHint } from "@/hooks/useComposerHint";
import type { ComposerHintContext } from "@/lib/composer-hint-context";
import type { ComposerHintMessage } from "@/lib/composer-hints";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // local object/data URL for display
}

export interface MessageQuote {
  entryId: string;
  role: "user" | "assistant";
  text: string;
}

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => Promise<boolean>;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => Promise<boolean>;
  onFollowUp?: (message: string, images?: AttachedImage[]) => Promise<boolean>;
  isStreaming: boolean;
  hintMessages?: ComposerHintMessage[] | null;
  hintContext?: ComposerHintContext;
  hintTurnKey?: string | null;
  model?: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: ModelCatalogEntry[];
  onModelChange?: (provider: string, modelId: string) => void;
  modelCatalogStatus?: ModelCatalogStatus;
  modelCatalogError?: string | null;
  modelCatalogDiagnostics?: ModelCatalogDiagnostic[];
  onRetryModelCatalog?: () => void;
  onOpenModels?: () => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  autoCompactionEnabled?: boolean | null;
  autoCompactionUpdating?: boolean;
  onAutoCompactionChange?: (enabled: boolean) => void;
  toolPreset?: ToolSelectionMode;
  availableTools?: ToolCatalogEntry[];
  customToolNames?: string[];
  onToolPresetChange?: (preset: ToolSelectionMode, customNames?: string[]) => void;
  onExitPlan?: () => Promise<boolean>;
  workflowControls?: ReactNode;
  workflowPending?: boolean;
  thinkingLevel?: ThinkingLevelOption;
  onThinkingLevelChange?: (level: ThinkingLevelOption) => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  ephemeral?: boolean;
  onEphemeralChange?: (enabled: boolean) => void;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  /** Project cwd — enables the `@file` mention autocomplete. */
  cwd?: string | null;
  /** Stable per-session key for draft/history persistence. */
  persistKey?: string | null;
  quote?: MessageQuote | null;
  onClearQuote?: () => void;
  onOpenQuote?: (entryId: string) => void;
  /** Keep the composer aligned with the selected transcript reading width. */
  wide?: boolean;
}

/**
 * Find an in-progress `@` mention before the caret: the `@` must be at the
 * start or after whitespace, and the token after it must not contain
 * whitespace (unless quoted with `"`, for paths with spaces).
 */
export function detectFileMention(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const token = before.slice(at + 1);
  if (token.startsWith('"')) {
    const inner = token.slice(1);
    if (inner.includes('"')) return null; // quote closed — mention finished
    return { start: at, query: inner };
  }
  if (/\s/.test(token)) return null;
  return { start: at, query: token };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  /** Forcefully replace the entire input value (no-op on identical value). */
  setText: (text: string) => void;
  /** Apply a tGD phase without losing the current prompt body. */
  applyPhase: (command: string) => void;
  addImages: (files: File[]) => void;
  addFiles: (files: File[]) => void;
  openControls?: () => void;
}

function resizeTextarea(textarea: HTMLTextAreaElement, expanded: boolean): void {
  textarea.style.height = "auto";
  const maxHeight = expanded ? Math.max(320, window.innerHeight - 240) : 200;
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
}

function ResponsiveComposerControls({
  isMobile,
  open,
  isStreaming,
  title,
  initialFocusRef,
  onClose,
  children,
}: {
  isMobile: boolean;
  open: boolean;
  isStreaming: boolean;
  title: string;
  initialFocusRef: RefObject<HTMLElement | null>;
  onClose: (restoreFocus?: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  if (isMobile && !isStreaming) {
    return (
      <DialogShell
        open={open}
        title={title}
        description={t("input.settingsImmediate")}
        onClose={() => onClose(false)}
        initialFocusRef={initialFocusRef}
        bodyClassName={styles.composerSettingsSheetBody}
        mobileMode="sheet"
        placement="center"
      >
        <div
          id="composer-secondary-tools"
          className={`${styles.bottomBarRightMobileOpen} ${styles.composerSettingsSheetContent}`}
          role="region"
          aria-label={title}
          data-testid="composer-controls-sheet"
        >
          {children}
        </div>
      </DialogShell>
    );
  }

  return (
    <div
      id="composer-secondary-tools"
      className={`${styles.bottomBarRight} ${open ? styles.bottomBarRightMobileOpen : ""} ${isStreaming ? styles.bottomBarRightStreaming : ""}`}
      role={open && !isStreaming ? "region" : undefined}
      aria-label={open && !isStreaming ? title : undefined}
    >
      {children}
    </div>
  );
}


export const ChatInput = memo(forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, model, modelNames, modelList, onModelChange,
  modelCatalogStatus, modelCatalogError, modelCatalogDiagnostics, onRetryModelCatalog, onOpenModels,
  onCompact, onAbortCompaction, isCompacting, autoCompactionEnabled, autoCompactionUpdating, onAutoCompactionChange, toolPreset, availableTools, customToolNames, onToolPresetChange,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo,
  ephemeral = false, onEphemeralChange,
  soundEnabled, onSoundToggle,
  cwd,
  persistKey,
  quote,
  onClearQuote,
  onOpenQuote,
  onExitPlan,
  workflowControls,
  workflowPending = false,
  wide = false,
  hintMessages,
  hintContext,
  hintTurnKey,
}: Props, ref) {
  const { t, locale } = useI18n();
  const hintHelpId = useId();
  const { prompts } = usePrompts();
  const slashItems = useMemo(() => buildSlashItems(prompts), [prompts]);
  const [value, setValue, readDraft] = useComposerDraft(persistKey ?? null);
  const onFilesUploaded = useCallback((names: string[]) => {
    const references = names.map(name => /\s/.test(name) ? `@"${name}"` : `@${name}`).join(" ");
    setValue(previous => `${previous}${previous && !/\s$/.test(previous) ? "\n" : ""}${references} `);
  }, [setValue]);
  const fileUploads = useFileAttachments(cwd, persistKey, onFilesUploaded);
  // Failed uploads must be retried or dismissed, not silently omitted on send.
  const uploadsPending = fileUploads.items.length > 0;
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const imageEpoch = useRef(0);
  const imagesRef = useRef(attachedImages);
  imagesRef.current = attachedImages;
  useLayoutEffect(() => {
    setAttachedImages([]);
    return () => {
      // Invalidate pending reads; this ref is a generation counter, not a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      imageEpoch.current++;
      imagesRef.current.forEach(image => URL.revokeObjectURL(image.previewUrl));
    };
  }, [cwd, persistKey]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const submissionKey = persistKey ?? `composer:${hintHelpId}`;
  const submissions = useComposerSubmissions(submissionKey);
  const isSubmitting = submissions.some(item => item.status === "pending");
  const submissionScope = useRef<object | null>(null);
  const currentQuote = useRef(quote);
  currentQuote.current = quote;
  useLayoutEffect(() => {
    submissionScope.current = {};
    return () => { submissionScope.current = null; };
  }, [submissionKey]);
  const exitPlan = useWorkflowCommand(persistKey ?? undefined, async () => onExitPlan ? onExitPlan() : false);
  const [expanded, setExpanded] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [composerEditing, setComposerEditing] = useState(false);
  const [streamingSendMode, setStreamingSendMode] = useState<StreamingSendMode>(() => loadStreamingSendMode());
  const contextMentions = useMemo(() => extractComposerMentions(value), [value]);

  // ── @file mention autocomplete ──
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionItems, setMentionItems] = useState<FileMentionItem[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionSeqRef = useRef(0);
  const { hint, enabled: hintsEnabled, setEnabled: setHintsEnabled, dismiss: dismissHint, reset: resetHint } = useComposerHint({
    messages: hintMessages, context: hintContext, model, locale, sessionKey: persistKey, turnKey: hintTurnKey,
    idle: value === "" && !isStreaming && !isCompacting && !isSubmitting && !uploadsPending
      && attachedImages.length === 0 && !quote && !workflowPending && !mention && !showSlashMenu,
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mobileToolsButtonRef = useRef<HTMLButtonElement>(null);
  const mobileControlsInitialRef = useRef<HTMLButtonElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const lastEscAtRef = useRef(0);
  const controlsBeforeExpandRef = useRef(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const acceptHint = useCallback(() => {
    if (!hint || value !== "" || isComposingRef.current) return;
    setValue(hint);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [hint, value, setValue]);

  const processImageFiles = useCallback(async (files: File[]) => {
    if (hasPendingComposerSubmission(submissionKey)) { showToast(t("input.waitForDelivery"), { type: "info" }); return; }
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const epoch = imageEpoch.current;
    const newImages = await Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<AttachedImage>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              // result is "data:<mime>;base64,<data>"
              const base64 = result.split(",")[1];
              resolve({ data: base64, mimeType: file.type, previewUrl: URL.createObjectURL(file) });
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          })
      )
    );
    if (epoch !== imageEpoch.current || hasPendingComposerSubmission(submissionKey)) {
      if (epoch === imageEpoch.current) showToast(t("input.waitForDelivery"), { type: "info" });
      newImages.forEach(image => URL.revokeObjectURL(image.previewUrl));
      return;
    }
    setAttachedImages((prev) => [...prev, ...newImages]);
  }, [submissionKey, t]);

  const processFiles = (files: File[]) => {
    if (isSubmitting) return;
    void processImageFiles(files).catch(() => showToast(t("input.imageReadFailed"), { type: "error" }));
    void fileUploads.addFiles(files.filter(file => !file.type.startsWith("image/")));
  };

  useImperativeHandle(ref, () => ({
    openControls() {
      setMobileToolsOpen(true);
    },
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      setValue(text);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        resizeTextarea(ta, expandedRef.current);
      });
    },
    applyPhase(command: string) {
      if (!/^\/tgd-[a-z-]+$/.test(command)) return;
      // The draft setter reads its current value synchronously, including a
      // phase applied earlier in the same event before React commits.
      setValue(current => {
        const body = current.replace(/^\s*\/tgd-[a-z-]+(?=\s|$)[ \t]*/, "");
        return `${command} ${body}`;
      });
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        resizeTextarea(textarea, expandedRef.current);
      });
    },
    setText(text: string) {
      setValue(text);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        // Move cursor to end of the new text.
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
        resizeTextarea(ta, expandedRef.current);
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      setValue(newVal);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        resizeTextarea(ta, expandedRef.current);
      });
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
    addFiles(files: File[]) {
      processFiles(files);
    },
  }));

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      URL.revokeObjectURL(next[index].previewUrl);
      next.splice(index, 1);
      return next;
    });
  }, []);

  const clearImages = useCallback((submitted?: AttachedImage[]) => {
    setAttachedImages((prev) => {
      const targets = new Set((submitted ?? prev).map((image) => image.previewUrl));
      prev.forEach((image) => {
        if (targets.has(image.previewUrl)) URL.revokeObjectURL(image.previewUrl);
      });
      return prev.filter((image) => !targets.has(image.previewUrl));
    });
  }, []);

  // Fetch @file suggestions: directory listing for empty/`dir/` queries
  // (drill-down), fuzzy filename search otherwise. Debounced; stale responses
  // dropped via a sequence counter.
  useEffect(() => {
    if (!mention || !cwd) { setMentionItems([]); return; }
    const seq = ++mentionSeqRef.current;
    const q = mention.query;
    const timer = setTimeout(async () => {
      try {
        let items: FileMentionItem[] = [];
        const slash = q.lastIndexOf("/");
        if (q === "" || q.endsWith("/") || slash >= 0) {
          // List <cwd>/<dirPart> and filter by the segment being typed.
          const dirPart = slash >= 0 ? q.slice(0, slash) : "";
          const namePart = slash >= 0 ? q.slice(slash + 1).toLowerCase() : q.toLowerCase();
          const abs = dirPart ? joinFilePath(cwd, dirPart) : cwd;
          const res = await fetch(`/api/files/${encodeFilePathForApi(abs)}?type=list`);
          if (res.ok) {
            const d = await res.json() as { entries?: { name: string; isDir: boolean }[] };
            items = (d.entries ?? [])
              .filter((e) => !namePart || e.name.toLowerCase().includes(namePart))
              .map((e) => ({ name: e.name, relative: dirPart ? `${dirPart}/${e.name}` : e.name, isDir: e.isDir }));
          }
        } else {
          const res = await fetch(`/api/files/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`);
          if (res.ok) {
            const d = await res.json() as { results?: { name: string; relative: string; isDir: boolean }[] };
            items = (d.results ?? []).map((r) => ({ name: r.name, relative: r.relative, isDir: r.isDir }));
          }
        }
        if (mentionSeqRef.current === seq) {
          setMentionItems(items.slice(0, 15));
          setMentionIndex(0);
        }
      } catch {
        if (mentionSeqRef.current === seq) setMentionItems([]);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [mention, cwd]);

  const applyMention = useCallback((item: FileMentionItem) => {
    const ta = textareaRef.current;
    if (!ta || !mention) return;
    const caret = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, mention.start);
    const after = ta.value.slice(caret);
    // Dirs drill down (keep the menu open); files finish the mention.
    const inserted = item.isDir
      ? `@${item.relative}/`
      : item.relative.includes(" ") ? `@"${item.relative}" ` : `@${item.relative} `;
    const newVal = before + inserted + after;
    setValue(newVal);
    if (item.isDir) {
      setMention({ start: mention.start, query: `${item.relative}/` });
    } else {
      setMention(null);
      setMentionItems([]);
    }
    requestAnimationFrame(() => {
      const pos = before.length + inserted.length;
      ta.setSelectionRange(pos, pos);
      ta.focus();
    });
  }, [mention, setValue]);

  // Sent-message history — ArrowUp in an empty input recalls previous
  // messages, ArrowDown walks back toward the blank prompt (CLI muscle memory).
  // Persisted per session so it survives reloads.
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef(-1); // -1 = not navigating


  // ── Draft persistence ──────────────────────────────────────────────────
  // Restore draft + history when the session changes; save the draft
  // (debounced) as it's typed. A refresh or session switch no longer eats
  // whatever was mid-composition.
  useEffect(() => {
    historyRef.current = loadHistory(persistKey ?? null);
    historyPosRef.current = -1;
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        resizeTextarea(ta, expandedRef.current);
      }
    });
  }, [persistKey]);

  useEffect(() => {
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) resizeTextarea(textarea, expanded);
    });
  }, [expanded, value]);

  const closeMobileTools = useCallback((restoreFocus = false) => {
    setMobileToolsOpen(false);
    if (restoreFocus) requestAnimationFrame(() => mobileToolsButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 700px)");
    const update = () => setIsMobileViewport(media?.matches ?? false);
    update();
    media?.addEventListener?.("change", update);
    return () => media?.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (!mobileToolsOpen) return;
    if (isMobileViewport) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setMobileToolsOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Close the active selector first, keeping the icon toolbar available.
      if (containerRef.current?.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]')) return;
      closeMobileTools(true);
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeMobileTools, isMobileViewport, mobileToolsOpen]);

  useEffect(() => {
    if (!expanded) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
    const handleExpandedKeys = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (showSlashMenu || mention) return;
        event.preventDefault();
        setExpanded(false);
        setMobileToolsOpen(controlsBeforeExpandRef.current);
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleExpandedKeys);
    return () => document.removeEventListener("keydown", handleExpandedKeys);
  }, [expanded, mention, showSlashMenu]);

  const submit = useCallback(async (deliver: Props["onSend"]) => {
    const draft = readDraft() ?? "";
    const msg = draft.trim();
    if ((!msg && !attachedImages.length) || uploadsPending) return;
    const outgoing = quote ? `> ${quote.text.replace(/\n/g, "\n> ")}\n\n${msg}` : msg;
    const recoveryText = quote ? `> ${quote.text.replace(/\n/g, "\n> ")}\n\n${draft}` : draft;
    const submittedImages = [...attachedImages];
    const started = beginComposerSubmission(submissionKey, recoveryText, submittedImages, draft);
    if (!started) return;
    const { item: submission, persisted, restoredIds } = started;
    const scope = submissionScope.current;
    // Clear before awaiting transport. The recovery copy has separate ownership,
    // so later acknowledgements never clear the next draft or revoke its images.
    if (persisted) {
      setValue("");
      clearDraft(persistKey ?? null);
      clearImages(submittedImages);
      onClearQuote?.();
    }
    setShowSlashMenu(false); setMention(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    let sent = false;
    try {
      sent = await deliver(outgoing, submittedImages.length ? submittedImages : undefined);
    } catch { /* Keep the original payload recoverable even if a caller rejects. */ }
    if (sent) {
      const history = loadHistory(persistKey ?? null);
      if (history.at(-1) !== outgoing) history.push(outgoing);
      saveHistory(persistKey ?? null, history);
      if (scope && submissionScope.current === scope) {
        historyRef.current = history; historyPosRef.current = -1;
      }
      if (!persisted && scope && submissionScope.current === scope) {
        if (readDraft() === draft) { setValue(""); clearDraft(persistKey ?? null); }
        clearImages(submittedImages);
        if (currentQuote.current === quote) onClearQuote?.();
      }
      removeComposerSubmission(submissionKey, submission.id, restoredIds);
    } else if (scope && submissionScope.current === scope && readDraft() === ""
      && (!currentQuote.current || currentQuote.current === quote)
      && imagesRef.current.every(image => submittedImages.includes(image))) {
      if (currentQuote.current === quote && quote) onClearQuote?.();
      setValue(submission.text);
      setAttachedImages(submission.images);
      restoreComposerSubmission(submissionKey, submission.id);
    } else {
      // New text or another session must never be overwritten by a late failure.
      failComposerSubmission(submissionKey, submission.id);
    }
  }, [readDraft, attachedImages, uploadsPending, quote, submissionKey, setValue, persistKey, clearImages, onClearQuote]);

  const handleSend = useCallback(async () => {
    if (!isStreaming) await submit(onSend);
  }, [isStreaming, submit, onSend]);

  const sendQueued = useCallback(async (mode: StreamingSendMode) => {
    const deliver = mode === "steer" ? onSteer : onFollowUp;
    if (deliver) await submit(deliver);
  }, [onSteer, onFollowUp, submit]);

  const draftForRecovery = quote ? `> ${quote.text.replace(/\n/g, "\n> ")}\n\n${value}` : value;
  const restoreSubmission = (submission: ComposerSubmission) => {
    setValue(current => current && current !== submission.text ? `${current}\n\n${submission.text}` : submission.text);
    setAttachedImages(current => [...current, ...submission.images.filter(image => !current.some(existing => existing.data === image.data && existing.mimeType === image.mimeType))]);
    restoreComposerSubmission(submissionKey, submission.id);
    textareaRef.current?.focus();
  };

  const chooseStreamingSendMode = useCallback((mode: StreamingSendMode) => {
    setStreamingSendMode(mode);
    saveStreamingSendMode(mode);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (!isComposing && e.key === "Escape" && expanded && !mention && !showSlashMenu) {
        e.preventDefault();
        setExpanded(false);
        setMobileToolsOpen(controlsBeforeExpandRef.current);
        return;
      }

      // @file mention menu navigation. Skipped mid-IME-composition: Enter
      // there commits the composed text, and arrows move between candidates.
      if (!isComposing && mention && mentionItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => (i + 1) % mentionItems.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
          return;
        }
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
          e.preventDefault();
          if (mentionItems[mentionIndex]) applyMention(mentionItems[mentionIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMention(null);
          setMentionItems([]);
          return;
        }
      }

      // Slash menu navigation (same IME rule as the mention menu above)
      if (!isComposing && showSlashMenu) {
        const filtered = filterSlashItems(slashItems, slashFilter);

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashSelectedIndex((i) => (i + 1) % filtered.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (filtered[slashSelectedIndex]) {
            // Insert the item's payload (tGD `/name `, or a template's body),
            // don't auto-send.
            setValue(filtered[slashSelectedIndex].insert);
            setShowSlashMenu(false);
            setSlashFilter("");
            setSlashSelectedIndex(0);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowSlashMenu(false);
          setSlashFilter("");
          setSlashSelectedIndex(0);
          return;
        }
      }

      if (hint && !isComposing && !recentlyComposed && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === "Tab") { e.preventDefault(); acceptHint(); return; }
        if (e.key === "Escape") { e.preventDefault(); dismissHint(); return; }
      }

      // Esc-Esc while a run is streaming aborts it (CLI muscle memory).
      // Two presses within 600ms — a single Esc only arms it (and shows a
      // hint), so stray Escapes can't kill a run. Open menus consumed their
      // Escape above.
      if (e.key === "Escape" && isCompacting && !isComposing) {
        e.preventDefault();
        onAbortCompaction?.();
        return;
      }
      if (e.key === "Escape" && isStreaming && !isComposing) {
        e.preventDefault();
        const now = Date.now();
        if (now - lastEscAtRef.current < 600) {
          lastEscAtRef.current = 0;
          onAbort();
        } else {
          lastEscAtRef.current = now;
          showToast(t("input.escAbortHint"));
        }
        return;
      }

      // History recall: only when not composing and the input is empty or
      // already mid-recall, so normal multi-line cursor movement is untouched.
      if (!isComposing && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const h = historyRef.current;
        const navigating = historyPosRef.current !== -1;
        if (e.key === "ArrowUp" && h.length > 0 && (value === "" || navigating)) {
          e.preventDefault();
          const pos = navigating ? Math.max(0, historyPosRef.current - 1) : h.length - 1;
          historyPosRef.current = pos;
          setValue(h[pos]);
          return;
        }
        if (e.key === "ArrowDown" && navigating) {
          e.preventDefault();
          const pos = historyPosRef.current + 1;
          if (pos >= h.length) {
            historyPosRef.current = -1;
            setValue("");
          } else {
            historyPosRef.current = pos;
            setValue(h[pos]);
          }
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          const mode = resolveStreamingSendMode(e, streamingSendMode);
          void sendQueued(mode);
        } else {
          void handleSend();
        }
      }
    },
    [isStreaming, isCompacting, onAbortCompaction, onSteer, onFollowUp, sendQueued, handleSend, showSlashMenu, slashFilter, slashSelectedIndex, slashItems, value, mention, mentionItems, mentionIndex, applyMention, onAbort, t, expanded, streamingSendMode, setValue, hint, acceptHint, dismissHint]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    resizeTextarea(ta, expanded);

    const val = ta.value;

    // @file mention takes priority (it may contain "/" for drill-down, which
    // must not trigger the slash-command menu).
    if (cwd) {
      const m = detectFileMention(val, ta.selectionStart ?? val.length);
      setMention(m);
      if (m) {
        setShowSlashMenu(false);
        setSlashFilter("");
        return;
      }
    }

    // Slash commands are whole-message (selection replaces the entire input),
    // so only a "/" at the very start opens the menu — a mid-text "/" is a path.
    if (val.startsWith("/")) {
      const filterText = val.slice(1);
      if (filterText.includes(" ")) {
        setShowSlashMenu(false);
        setSlashFilter("");
      } else {
        setShowSlashMenu(true);
        setSlashFilter(filterText);
        // Keep the selection inside the narrowed list — a stale index past the
        // end leaves nothing highlighted and Enter a no-op.
        const count = filterSlashItems(slashItems, filterText).length;
        setSlashSelectedIndex((i) => (filterText === "" ? 0 : Math.min(i, Math.max(0, count - 1))));
      }
    } else {
      setShowSlashMenu(false);
      setSlashFilter("");
    }
  }, [cwd, slashItems, expanded]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length) {
      e.preventDefault();
      const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      processImageFiles(files);
      return;
    }
    // Code-shaped multiline pastes get fenced so the transcript's markdown
    // render doesn't mangle them (conservative heuristic — prose is untouched).
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (shouldFencePaste(text)) {
      e.preventDefault();
      const ta = textareaRef.current;
      const fenced = fencePaste(text);
      if (!ta) { setValue((v) => v + fenced); return; }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? start;
      const newVal = ta.value.slice(0, start) + fenced + ta.value.slice(end);
      setValue(newVal);
      requestAnimationFrame(() => {
        ta.setSelectionRange(start + fenced.length, start + fenced.length);
        resizeTextarea(ta, expanded);
      });
    }
  }, [processImageFiles, expanded, setValue]);

  const removeContextMention = useCallback((item: ComposerMention) => {
    setValue((current) => removeComposerMention(current, item));
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      resizeTextarea(textarea, expandedRef.current);
    });
  }, [setValue]);

  const toggleExpanded = useCallback(() => {
    if (!expanded) {
      controlsBeforeExpandRef.current = mobileToolsOpen;
      if (isMobileViewport) setMobileToolsOpen(false);
    } else {
      setMobileToolsOpen(controlsBeforeExpandRef.current);
    }
    setExpanded(!expanded);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [expanded, isMobileViewport, mobileToolsOpen]);



  // Consolidate model/thinking/tool-preset state derivations
  const { modelOptions, modelsByProvider, currentName } = useChatInputControls({
    model,
    modelNames,
    modelList,
    onModelChange,
    thinkingLevel,
    onThinkingLevelChange,
    availableThinkingLevels,
    thinkingLevelMap,
    toolPreset,
    onToolPresetChange,
  });

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node) &&
          textareaRef.current && !textareaRef.current.contains(e.target as Node)) {
        setShowSlashMenu(false);
        setSlashFilter("");
        setSlashSelectedIndex(0);
      }
      // Close the @file menu on outside clicks (its items handle mousedown).
      if (!(e.target as HTMLElement).closest?.('[data-testid="file-mention-menu"]') &&
          textareaRef.current && !textareaRef.current.contains(e.target as Node)) {
        setMention(null);
        setMentionItems([]);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);



  return (
    <div
      ref={containerRef}
      className={expanded ? `${styles.container} ${styles.containerExpanded}` : styles.container}
      data-composer-editing={composerEditing}
      onFocusCapture={(event) => {
        // Only text editing enters the keyboard layout. A first click on a
        // toolbar button must not move that button between down and up.
        const target = event.nativeEvent.target;
        if (target instanceof HTMLTextAreaElement && target === textareaRef.current) setComposerEditing(true);
      }}
      onBlurCapture={(event) => {
        // Keep the layout while focus moves to a composer control; restoring
        // the mobile nav here would move its click target before pointerup.
        if (!event.currentTarget.contains(event.relatedTarget)) setComposerEditing(false);
      }}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label={expanded ? t("input.expandedTitle") : undefined}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        aria-label={t("input.attachFiles")}
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processFiles(files);
          e.target.value = "";
        }}
      />
      <div
        className={expanded
          ? `${styles.innerWrapper} ${styles.innerWrapperExpanded}`
          : `${styles.innerWrapper} ${wide ? styles.innerWrapperWide : ""}`}
        data-testid="composer-toolbar"
      >
        {expanded && (
          <div className={styles.expandedHeader}>
            <div>
              <strong>{t("input.expandedTitle")}</strong>
              <span>{t("input.expandedHint")}</span>
            </div>
            <button type="button" onClick={toggleExpanded} aria-label={t("input.collapseComposer")} title={t("input.collapseComposer")}>
              <Minimize2 size={UI_ICON_SIZE.compact} aria-hidden="true" />
            </button>
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div className={styles.retryBanner}>
            <RefreshCw size={UI_ICON_SIZE.inline} className={styles.retryIcon} aria-hidden="true" />
            {t("input.retrying")} ({retryInfo.attempt}/{retryInfo.maxAttempts})…{retryInfo.errorMessage && <span className={styles.retryErrorText}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {submissions.length > 0 && <div className={styles.deliveryNotices}>
          {submissions.map(submission => submission.status === "pending" ? (
            <div key={submission.id} className={styles.deliveryNotice} role="status">{t("input.sending")}</div>
          ) : (
            <div key={submission.id} className={styles.deliveryNotice} role="alert">
              <details><summary>{t(submission.status === "unknown" ? "input.deliveryUnknown" : submission.status === "restored" ? "input.restoredDraft" : "input.unsentDraft")}</summary>
                <p>{submission.text}</p>
                {submission.images.length > 0 && <span>{t("input.savedImages").replace("{count}", String(submission.images.length))}</span>}
              </details>
              <button type="button" disabled={isSubmitting || (draftForRecovery === submission.text && sameSubmissionImages(attachedImages, submission.images))} onClick={() => restoreSubmission(submission)}>{t(value || attachedImages.length ? "input.appendUnsentDraft" : "input.restoreDraft")}</button>
              <button type="button" onClick={() => removeComposerSubmission(submissionKey, submission.id)} aria-label={t("input.discardUnsentDraft")}><X size={UI_ICON_SIZE.inline} aria-hidden="true" /></button>
            </div>
          ))}
        </div>}
        {quote && (
          <div className={styles.quoteRow} aria-label={quote.role === "user" ? t("chat.quoteYou") : t("chat.quoteAssistant")}>
            <button type="button" className={styles.quoteOpen} onClick={() => onOpenQuote?.(quote.entryId)} title={t("chat.openQuote")}>
              <span className={styles.quoteLabel}>{quote.role === "user" ? t("chat.quoteYou") : t("chat.quoteAssistant")}</span>
              <span className={styles.quotePreview}>{quote.text}</span>
            </button>
            <button type="button" className={styles.quoteRemove} onClick={onClearQuote} aria-label={t("chat.clearQuote")} title={t("chat.clearQuote")}>
              <X size={UI_ICON_SIZE.compact} aria-hidden="true" />
            </button>
          </div>
        )}
        {contextMentions.length > 0 && (
          <div className={styles.contextRow} aria-label={t("input.contextFiles")}>
            <span className={styles.contextLabel}>{t("input.context")}</span>
            <div className={styles.contextChips}>
              {contextMentions.map((item) => (
                <span className={styles.contextChip} key={`${item.start}:${item.raw}`}>
                  <button
                    type="button"
                    className={styles.contextOpen}
                    onClick={() => requestOpenFile({ path: item.path })}
                    title={item.path}
                  >
                    <FileText size={UI_ICON_SIZE.inline} aria-hidden="true" />
                    <span>{item.path}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.contextRemove}
                    onClick={() => removeContextMention(item)}
                    disabled={isSubmitting}
                    aria-label={`${t("input.removeContext")} ${item.path}`}
                    title={t("input.removeContext")}
                  ><X size={UI_ICON_SIZE.compact} aria-hidden="true" /></button>
                </span>
              ))}
            </div>
          </div>
        )}
        {fileUploads.items.length > 0 && (
          <div className={styles.uploadList} aria-live="polite" aria-label={t("input.fileUploads")}>
            <span className={styles.uploadHint}>{t("input.uploadHint")}</span>
            {fileUploads.items.map(item => (
              <div key={item.id} className={styles.uploadItem}>
                <FileText size={UI_ICON_SIZE.compact} aria-hidden="true" />
                <div className={styles.uploadInfo}>
                  <strong title={item.file.name}>{item.file.name}</strong>
                  <span role={item.error ? "alert" : "status"}>{item.error ?? t("input.uploading")}</span>
                </div>
                {item.error &&
                  <button type="button" onClick={() => fileUploads.retry(item)} aria-label={`${t("input.retryUpload")} ${item.file.name}`}><RefreshCw size={UI_ICON_SIZE.compact} aria-hidden="true" /></button>
                }
                <button type="button" onClick={() => fileUploads.dismiss(item.id)} aria-label={`${t(item.error ? "input.dismissUpload" : "input.cancelUpload")} ${item.file.name}`}><X size={UI_ICON_SIZE.compact} aria-hidden="true" /></button>
              </div>
            ))}
          </div>
        )}
        {contextMentions.length > 0 && <p className={styles.uploadHint}>{t("input.fileReferenceHint")}</p>}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div className={styles.imagePreviewRow}>
            {attachedImages.map((img, i) => (
              <div key={i} className={styles.imagePreviewItem}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  className={styles.imagePreviewImg}
                />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  disabled={isSubmitting}
                  aria-label={t("input.removeImage")}
                  title={t("input.removeImage")}
                  className={styles.imageRemoveButton}
                >
                  <X size={UI_ICON_SIZE.compact} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input */}
        <div
          className={`${isStreaming && (onSteer || onFollowUp) ? styles.inputWrapperStreaming : styles.inputWrapperNormal} ${expanded ? styles.inputWrapperExpanded : ""}`}
          data-testid="composer-shell"
        >
          <div className={styles.inputRow} data-testid="composer-input-row">
          <div className={styles.draftArea}>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (e.target.value === "") resetHint();
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            aria-busy={isSubmitting}
            aria-label={t("input.message")}
            aria-describedby={hint ? hintHelpId : undefined}
            aria-keyshortcuts={hint ? "Tab" : undefined}
            placeholder={
              isCompacting ? t("compact.placeholder")
              : isStreaming && (onSteer || onFollowUp)
                ? t(streamingSendMode === "steer" ? "input.steerPlaceholder" : "input.followUpPlaceholder")
                : isStreaming ? t("input.agentRunning")
                : hint ? "" : t("input.message")
            }
            rows={1}
            className={expanded ? `${styles.textarea} ${styles.textareaExpanded}` : styles.textarea}
          />
          {hint && (
            <>
            <span id={hintHelpId} className="sr-only">{t("input.hintHelp")}</span>
            <button type="button" className={styles.hintOverlay} onClick={acceptHint}
              aria-label={`${t("input.useHint")}: ${hint}`} title={t("input.hintHelp")}
              data-testid="composer-hint">
              <span className={styles.hintText}>{hint}</span>
              <kbd className={styles.hintShortcut} aria-hidden="true">{t("input.hintTab")}</kbd>
            </button>
            </>
          )}
          </div>

          {/* @file mention menu */}
          <FileMentionMenu
            show={!!mention}
            items={mentionItems}
            selectedIndex={mentionIndex}
            onSelect={applyMention}
            onHover={setMentionIndex}
          />

          {/* Slash command menu */}
          <SlashMenu
            show={showSlashMenu}
            items={slashItems}
            filter={slashFilter}
            selectedIndex={slashSelectedIndex}
            onSelect={(insert) => {
              setValue(insert);
              setShowSlashMenu(false);
              setSlashFilter("");
              setSlashSelectedIndex(0);
              textareaRef.current?.focus();
            }}
            onHover={setSlashSelectedIndex}
            onLeave={() => setSlashSelectedIndex(-1)}
            onClose={() => setShowSlashMenu(false)}
          />

          {isStreaming ? (
            <div className={styles.streamingActions}>
              <button
                type="button"
                onClick={() => void sendQueued(streamingSendMode)}
                disabled={isSubmitting || uploadsPending || (!value.trim() && !attachedImages.length)}
                title={streamingSendMode === "steer" ? t("input.steerActionTitle") : t("input.followUpActionTitle")}
                aria-label={streamingSendMode === "steer" ? t("input.steerActionTitle") : t("input.followUpActionTitle")}
                className={
                  streamingSendMode === "steer"
                    ? ((value.trim() || attachedImages.length) && !isSubmitting && !uploadsPending ? styles.steerButtonActive : styles.steerButtonDisabled)
                    : ((value.trim() || attachedImages.length) && !isSubmitting && !uploadsPending ? styles.followUpButtonActive : styles.followUpButtonDisabled)
                }
              >
                {streamingSendMode === "steer" ? (
                  <ArrowRight size={UI_ICON_SIZE.inline} aria-hidden="true" />
                ) : (
                  <Upload size={UI_ICON_SIZE.inline} aria-hidden="true" />
                )}
                <span className={styles.actionLabel}>{t(streamingSendMode === "steer" ? "input.steer" : "input.followUp")}</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={isSubmitting || uploadsPending || (!value.trim() && !attachedImages.length)}
              aria-label={t("input.send")}
              className={(value.trim() || attachedImages.length) && !isSubmitting && !uploadsPending ? styles.sendButtonActive : styles.sendButtonDisabled}
            >
              <ArrowRight size={UI_ICON_SIZE.compact} aria-hidden="true" />
              <span className={styles.actionLabel}>{t("input.send")}</span>
            </button>
          )}
          </div>
        </div>

        {/* Bottom bar: left | center (context) | right */}
        <div className={`${styles.bottomBar} ${isStreaming ? styles.bottomBarStreaming : ""}`}>

          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          <div className={styles.bottomBarLeft}>
            <button
              onClick={() => fileInputRef.current?.click()}
              type="button"
              disabled={isSubmitting}
              title={t("input.attachFilesHint")}
              aria-label={t("input.attachFiles")}
              className={isSubmitting ? styles.attachButtonDisabled : styles.attachButtonEnabled}
              style={{ color: attachedImages.length ? "var(--accent)" : "var(--text-muted)" }}
            >
              <Paperclip size={UI_ICON_SIZE.control} aria-hidden="true" />
            </button>
            <ScreenshotButton
              key={JSON.stringify([cwd, persistKey])}
              className={isSubmitting ? styles.attachButtonDisabled : styles.attachButtonEnabled}
              disabled={isSubmitting}
              onChooseFile={() => fileInputRef.current?.click()}
              onAttach={({ dataUrl }) => {
                if (hasPendingComposerSubmission(submissionKey)) { showToast(t("input.waitForDelivery"), { type: "info" }); return; }
                setAttachedImages(previous => [...previous, {
                  data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/png", previewUrl: dataUrl,
                }]);
              }}
            />
            {isStreaming && onSteer && onFollowUp && (
              <div className={styles.sendModeSwitch} aria-label={t("input.sendMode")} role="group">
                <button
                  type="button"
                  className={streamingSendMode === "followup" ? styles.sendModeActiveFollowUp : styles.sendModeButton}
                  onClick={() => chooseStreamingSendMode("followup")}
                  aria-pressed={streamingSendMode === "followup"}
                  title={t("input.followUpShortcut")}
                >{t("input.followUp")}</button>
                <button
                  type="button"
                  className={streamingSendMode === "steer" ? styles.sendModeActiveSteer : styles.sendModeButton}
                  onClick={() => chooseStreamingSendMode("steer")}
                  aria-pressed={streamingSendMode === "steer"}
                  title={t("input.steerShortcut")}
                >{t("input.steer")}</button>
              </div>
            )}
            {/* Model selector — visible always, disabled during streaming */}
            <ModelSelector
              onOpen={closeMobileTools}
              modelOptions={modelOptions}
              modelsByProvider={modelsByProvider}
              currentName={currentName}
              model={model}
              isStreaming={isStreaming || !!isCompacting}
              onModelChange={onModelChange}
              catalogStatus={modelCatalogStatus}
              catalogError={modelCatalogError}
              catalogDiagnostics={modelCatalogDiagnostics}
              onRetry={onRetryModelCatalog}
              onOpenModels={onOpenModels}
              className={styles.modelControl}
            />
          </div>

          <span className={styles.keyboardHint}>{t("input.keyboardHint")}</span>

          {workflowControls}

          {!isStreaming && (
            <button
              ref={mobileToolsButtonRef}
              type="button"
              className={`${styles.mobileToolsButton} ${mobileToolsOpen ? styles.mobileToolsButtonActive : ""}`}
              onClick={(event) => {
                event.currentTarget.focus();
                setMobileToolsOpen((open) => !open);
              }}
              aria-label={t("input.moreControls")}
              title={t("input.controlsTitle")}
              aria-expanded={mobileToolsOpen}
              aria-haspopup={isMobileViewport ? "dialog" : undefined}
              aria-controls="composer-secondary-tools"
            >
              <SlidersHorizontal size={UI_ICON_SIZE.control} aria-hidden="true" />
            </button>
          )}

          {/* RIGHT: thinking + tools preset + compact + sound (idle) | Stop + sound (streaming) */}
          <ResponsiveComposerControls
            isMobile={isMobileViewport}
            open={mobileToolsOpen}
            isStreaming={isStreaming}
            title={t("input.controlsTitle")}
            initialFocusRef={mobileControlsInitialRef}
            onClose={closeMobileTools}
          >
            <div className={styles.mobileToolsHeader}>
              <span>{t("input.controlsTitle")}</span>
              <button type="button" onClick={(event) => closeMobileTools(event.detail === 0)}>
                {t("input.controlsDone")}
              </button>
            </div>
            <div className={styles.mobileLabeledControl}>
              <span className={styles.mobileControlLabel}>{t("input.composerSize")}</span>
              <button
                ref={mobileControlsInitialRef}
                type="button"
                onClick={toggleExpanded}
                className={styles.expandButton}
                aria-expanded={expanded}
                aria-label={expanded ? t("input.collapseComposer") : t("input.expandComposer")}
                title={expanded ? t("input.collapseComposer") : t("input.expandComposer")}
              >
                {expanded ? (
                  <Minimize2 size={UI_ICON_SIZE.control} aria-hidden="true" />
                ) : (
                  <Maximize2 size={UI_ICON_SIZE.control} aria-hidden="true" />
                )}
                <span className={styles.mobileControlValue}>{t(expanded ? "input.collapseComposerShort" : "input.expandComposerShort")}</span>
              </button>
            </div>
            <div className={styles.mobileLabeledControl}>
              <span className={styles.mobileControlLabel}>{t("input.reasoning")}</span>
              <ThinkingSelector
                thinkingLevel={thinkingLevel}
                thinkingLevelMap={thinkingLevelMap}
                availableThinkingLevels={availableThinkingLevels}
                isStreaming={isStreaming || !!isCompacting}
                presentation={isMobileViewport ? "inline" : "popover"}
                iconOnly={!isMobileViewport}
                onThinkingLevelChange={onThinkingLevelChange}
              />
            </div>
            <div className={styles.mobileLabeledControl}>
              <span className={styles.mobileControlLabel}>{t("input.contextHints")}</span>
              <button type="button" className={styles.expandButton} aria-pressed={hintsEnabled}
                aria-label={t("input.contextHints")} title={t("input.contextHintsHelp")}
                onClick={() => setHintsEnabled(!hintsEnabled)}>
                <Sparkles size={UI_ICON_SIZE.control} aria-hidden="true" />
                <span className={styles.mobileControlValue}>{t(hintsEnabled ? "input.hintsOn" : "input.hintsOff")}</span>
              </button>
            </div>
            <div className={styles.mobileLabeledControl}>
              <span className={styles.mobileControlLabel}>{t("input.tools")}</span>
              <ToolPresetSelector
                toolPreset={toolPreset}
                availableTools={availableTools}
                customToolNames={customToolNames}
                isStreaming={isStreaming}
                presentation={isMobileViewport ? "inline" : "popover"}
                iconOnly={!isMobileViewport}
                onToolPresetChange={onToolPresetChange}
              />
            </div>
            {toolPreset === "plan" && onExitPlan && (
              <div className={styles.mobileLabeledControl}>
                <button type="button" className={styles.expandButton}
                  aria-label={t("workflow.exitPlan")} title={t("workflow.exitPlan")}
                  disabled={exitPlan.pending || workflowPending || isStreaming || !!isCompacting}
                  onClick={async () => {
                    try { await exitPlan.run("/plan exit"); }
                    catch (error) { showToast(error instanceof Error ? error.message : String(error), { type: "error" }); }
                  }}>
                  <LogOut size={UI_ICON_SIZE.control} aria-hidden />
                  <span className={styles.mobileControlValue}>{t("workflow.exitPlan")}</span>
                </button>
              </div>
            )}
            <div className={`${styles.mobileLabeledControl} ${styles.scrollModeControl}`}>
              <span className={styles.mobileControlLabel}>{t("input.scrollMode")}</span>
              <ScrollFollowSelector iconOnly={!isMobileViewport} />
            </div>

            {!isStreaming && onEphemeralChange && (
              <div className={styles.mobileLabeledControl}>
                <span className={styles.mobileControlLabel}>{t("input.sessionStorage")}</span>
                <button type="button" onClick={() => onEphemeralChange(!ephemeral)} aria-label={t(ephemeral ? "input.ephemeral" : "input.persisted")} aria-pressed={ephemeral} className={ephemeral ? styles.autoCompactButtonOn : styles.autoCompactButtonOff} title={`${t(ephemeral ? "input.ephemeral" : "input.persisted")} — ${t("input.ephemeralHint")}`}>
                  <Ghost size={UI_ICON_SIZE.control} aria-hidden="true" />
                  <span className={styles.mobileControlValue}>{t(ephemeral ? "input.ephemeral" : "input.persisted")}</span>
                </button>
              </div>
            )}

            {!isStreaming && onCompact && (
              <>
                {autoCompactionEnabled !== null && autoCompactionEnabled !== undefined && onAutoCompactionChange && (
                  <div className={styles.mobileLabeledControl}>
                    <span className={styles.mobileControlLabel}>{t("chat.autoCompact")}</span>
                    <button
                      type="button"
                      onClick={() => onAutoCompactionChange(!autoCompactionEnabled)}
                      disabled={isCompacting || autoCompactionUpdating}
                      aria-label={`${t("chat.autoCompact")} ${autoCompactionEnabled ? t("chat.on") : t("chat.off")}`}
                      aria-pressed={autoCompactionEnabled}
                      title={autoCompactionEnabled ? t("chat.autoCompactOnTitle") : t("chat.autoCompactOffTitle")}
                      className={autoCompactionEnabled ? styles.autoCompactButtonOn : styles.autoCompactButtonOff}
                    >
                      <RefreshCw size={UI_ICON_SIZE.control} aria-hidden="true" />
                      <span className={styles.mobileControlValue}>{t(autoCompactionEnabled ? "chat.on" : "chat.off")}</span>
                    </button>
                  </div>
                )}
                <div className={styles.mobileLabeledControl}>
                  <span className={styles.mobileControlLabel}>{t("input.contextControl")}</span>
                  <div className={styles.compactWrapper}>
                    <button
                      type="button"
                      aria-label={isCompacting ? t("chat.stopCompaction") : t("chat.compactNow")}
                      onClick={isCompacting ? onAbortCompaction : onCompact}
                      className={isCompacting ? styles.compactButtonCompacting : styles.compactButtonIdle}
                      title={isCompacting ? t("chat.stopCompaction") : t("chat.compactTitle")}
                    >
                      {isCompacting ? (
                        <><Square size={UI_ICON_SIZE.control} aria-hidden="true" /><span className={styles.mobileControlValue}>{t("chat.compacting")}</span></>
                      ) : (
                        <><Shrink size={UI_ICON_SIZE.control} aria-hidden="true" /><span className={styles.mobileControlValue}>{t("chat.compactNow")}</span></>
                      )}
                    </button>
                  </div>
                </div>
              </>
            )}

            {isStreaming && (
              <button
                type="button"
                onClick={onAbort}
                title={t("input.stopTitle")}
                className={styles.stopButton}
              >
                <Square size={UI_ICON_SIZE.inline} fill="currentColor" aria-hidden="true" />
                {t("input.stop")}
              </button>
            )}

            {onSoundToggle !== undefined && (
              <div className={`${styles.mobileLabeledControl} ${styles.mobileSoundControl}`}>
                <span className={styles.mobileControlLabel}>{t("input.sound")}</span>
                <button
                  type="button"
                  onClick={onSoundToggle}
                  aria-pressed={soundEnabled}
                  aria-label={soundEnabled ? t("input.soundOnTitle") : t("input.soundOffTitle")}
                  title={soundEnabled ? t("input.soundOnTitle") : t("input.soundOffTitle")}
                  className={soundEnabled ? styles.soundButtonEnabled : styles.soundButtonDisabled}

                >
                  {soundEnabled ? (
                    <Volume2 size={UI_ICON_SIZE.control} aria-hidden="true" />
                  ) : (
                    <VolumeX size={UI_ICON_SIZE.control} aria-hidden="true" />
                  )}
                  <span className={styles.mobileControlValue}>{t(soundEnabled ? "chat.on" : "chat.off")}</span>
                </button>
              </div>
            )}
          </ResponsiveComposerControls>

        </div>

      </div>
    </div>
  );
}));
