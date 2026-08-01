"use client";

import React, { useRef, useState, useCallback, useEffect, useMemo, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import { COMPOSITION_END_ENTER_GRACE_MS, buildSlashItems } from "./chat-input-constants";
import { SlashMenu, filterSlashItems } from "./SlashMenu";
import { loadDraft, saveDraft, clearDraft, loadHistory, saveHistory } from "@/lib/composer-persistence";
import { shouldFencePaste, fencePaste } from "@/lib/paste-fence";
import { showToast } from "@/hooks/useToast";
import { FileMentionMenu, type FileMentionItem } from "./FileMentionMenu";
import { encodeFilePathForApi, joinFilePath } from "@/lib/file-paths";
import { usePrompts } from "@/hooks/usePrompts";
import { ModelSelector } from "./ModelSelector";
import { ThinkingSelector } from "./ThinkingSelector";
import { ToolPresetSelector } from "./ToolPresetSelector";
import { useChatInputControls } from "@/hooks/useChatInputControls";
import styles from "./ChatInput.module.css";
import { useI18n } from "@/lib/i18n";
import { extractComposerMentions, removeComposerMention, type ComposerMention } from "@/lib/composer-context";
import { loadStreamingSendMode, resolveStreamingSendMode, saveStreamingSendMode, type StreamingSendMode } from "@/lib/composer-mode";
import { requestOpenFile } from "@/lib/file-links";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
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
  model?: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  onModelChange?: (provider: string, modelId: string) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  autoCompactionEnabled?: boolean | null;
  autoCompactionUpdating?: boolean;
  onAutoCompactionChange?: (enabled: boolean) => void;
  toolPreset?: "none" | "default" | "full";
  onToolPresetChange?: (preset: "none" | "default" | "full") => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
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
  addImages: (files: File[]) => void;
}

function resizeTextarea(textarea: HTMLTextAreaElement, expanded: boolean): void {
  textarea.style.height = "auto";
  const maxHeight = expanded ? Math.max(320, window.innerHeight - 240) : 200;
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
}


export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, model, modelNames, modelList, onModelChange,
  onCompact, onAbortCompaction, isCompacting, compactError, autoCompactionEnabled, autoCompactionUpdating, onAutoCompactionChange, toolPreset, onToolPresetChange,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo,
  soundEnabled, onSoundToggle,
  cwd,
  persistKey,
  quote,
  onClearQuote,
  onOpenQuote,
  wide = false,
}: Props, ref) {
  const { t } = useI18n();
  const { prompts } = usePrompts();
  const slashItems = useMemo(() => buildSlashItems(prompts), [prompts]);
  const [value, setValue] = useState("");
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [streamingSendMode, setStreamingSendMode] = useState<StreamingSendMode>(() => loadStreamingSendMode());
  const contextMentions = useMemo(() => extractComposerMentions(value), [value]);

  // ── @file mention autocomplete ──
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionItems, setMentionItems] = useState<FileMentionItem[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionSeqRef = useRef(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const lastEscAtRef = useRef(0);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  useImperativeHandle(ref, () => ({
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
    setText(text: string) {
      // Forcefully replace the entire input value. Used by quick-action
      // buttons (e.g. tGD phase chips) so clicking a different phase
      // swaps the slash command rather than appending to the existing one.
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
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
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
    setAttachedImages((prev) => [...prev, ...newImages]);
  }, []);

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
  }, [mention]);

  // Sent-message history — ArrowUp in an empty input recalls previous
  // messages, ArrowDown walks back toward the blank prompt (CLI muscle memory).
  // Persisted per session so it survives reloads.
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef(-1); // -1 = not navigating
  const pushHistory = useCallback((msg: string) => {
    if (!msg) return;
    const h = historyRef.current;
    if (h[h.length - 1] !== msg) h.push(msg);
    if (h.length > 50) h.shift();
    historyPosRef.current = -1;
    saveHistory(persistKey ?? null, h);
  }, [persistKey]);

  // ── Draft persistence ──────────────────────────────────────────────────
  // Restore draft + history when the session changes; save the draft
  // (debounced) as it's typed. A refresh or session switch no longer eats
  // whatever was mid-composition.
  useEffect(() => {
    setValue(loadDraft(persistKey ?? null));
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
  }, [expanded]);

  useEffect(() => {
    if (!mobileToolsOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setMobileToolsOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMobileToolsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileToolsOpen]);

  useEffect(() => {
    if (!expanded) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
    const handleExpandedKeys = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (showSlashMenu || mention) return;
        event.preventDefault();
        setExpanded(false);
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

  useEffect(() => {
    const timer = setTimeout(() => saveDraft(persistKey ?? null, value), 300);
    return () => clearTimeout(timer);
  }, [value, persistKey]);

  const handleSend = useCallback(async () => {
    const msg = value.trim();
    if ((!msg && !attachedImages.length) || isStreaming || isSubmitting) return;
    const submittedValue = value;
    const submittedImages = [...attachedImages];
    setIsSubmitting(true);
    try {
      const outgoing = quote ? `> ${quote.text.replace(/\n/g, "\n> ")}\n\n${msg}` : msg;
      const sent = await onSend(outgoing, submittedImages.length ? submittedImages : undefined);
      if (!sent) return;
      pushHistory(outgoing);
      clearImages(submittedImages);
      onClearQuote?.();
      if ((textareaRef.current?.value ?? value) === submittedValue) {
        setValue("");
        clearDraft(persistKey ?? null);
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [value, attachedImages, isStreaming, isSubmitting, onSend, clearImages, pushHistory, persistKey, quote, onClearQuote]);

  const sendQueued = useCallback(async (mode: StreamingSendMode) => {
    const msg = value.trim();
    if ((!msg && !attachedImages.length) || isSubmitting) return;
    const submittedValue = value;
    const submittedImages = [...attachedImages];
    setIsSubmitting(true);
    try {
      let sent = false;
      const outgoing = quote ? `> ${quote.text.replace(/\n/g, "\n> ")}\n\n${msg}` : msg;
      if (mode === "steer" && onSteer) {
        sent = await onSteer(outgoing, submittedImages.length ? submittedImages : undefined);
      } else if (mode === "followup" && onFollowUp) {
        sent = await onFollowUp(outgoing, submittedImages.length ? submittedImages : undefined);
      }
      if (sent) {
        pushHistory(outgoing);
        clearImages(submittedImages);
        onClearQuote?.();
        if ((textareaRef.current?.value ?? value) === submittedValue) {
          setValue("");
          clearDraft(persistKey ?? null);
          if (textareaRef.current) textareaRef.current.style.height = "auto";
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [value, attachedImages, isSubmitting, onSteer, onFollowUp, clearImages, pushHistory, persistKey, quote, onClearQuote]);

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

      // Esc-Esc while a run is streaming aborts it (CLI muscle memory).
      // Two presses within 600ms — a single Esc only arms it (and shows a
      // hint), so stray Escapes can't kill a run. Open menus consumed their
      // Escape above.
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
    [isStreaming, onSteer, onFollowUp, sendQueued, handleSend, showSlashMenu, slashFilter, slashSelectedIndex, slashItems, value, mention, mentionItems, mentionIndex, applyMention, onAbort, t, expanded, streamingSendMode]
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
  }, [processImageFiles, expanded]);

  const removeContextMention = useCallback((item: ComposerMention) => {
    setValue((current) => removeComposerMention(current, item));
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      resizeTextarea(textarea, expandedRef.current);
    });
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);



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
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label={expanded ? t("input.expandedTitle") : undefined}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processImageFiles(files);
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m8 3-5 5m0-5v5h5M16 21l5-5m0 5v-5h-5" />
              </svg>
            </button>
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div className={styles.retryBanner}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.retryIcon}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            {t("input.retrying")} ({retryInfo.attempt}/{retryInfo.maxAttempts})…{retryInfo.errorMessage && <span className={styles.retryErrorText}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {quote && (
          <div className={styles.quoteRow} aria-label={quote.role === "user" ? t("chat.quoteYou") : t("chat.quoteAssistant")}>
            <button type="button" className={styles.quoteOpen} onClick={() => onOpenQuote?.(quote.entryId)} title={t("chat.openQuote")}>
              <span className={styles.quoteLabel}>{quote.role === "user" ? t("chat.quoteYou") : t("chat.quoteAssistant")}</span>
              <span className={styles.quotePreview}>{quote.text}</span>
            </button>
            <button type="button" className={styles.quoteRemove} onClick={onClearQuote} aria-label={t("chat.clearQuote")} title={t("chat.clearQuote")}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
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
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span>{item.path}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.contextRemove}
                    onClick={() => removeContextMention(item)}
                    disabled={isSubmitting}
                    aria-label={`${t("input.removeContext")} ${item.path}`}
                    title={t("input.removeContext")}
                  >×</button>
                </span>
              ))}
            </div>
          </div>
        )}
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
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
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
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
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
            readOnly={isSubmitting}
            aria-busy={isSubmitting}
            placeholder={
              isStreaming && (onSteer || onFollowUp)
                ? t("input.steerHint")
                : isStreaming ? t("input.agentRunning")
                : t("input.message")
            }
            rows={1}
            className={expanded ? `${styles.textarea} ${styles.textareaExpanded}` : styles.textarea}
          />

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
                disabled={isSubmitting || (!value.trim() && !attachedImages.length)}
                title={streamingSendMode === "steer" ? t("input.steerActionTitle") : t("input.followUpActionTitle")}
                aria-label={streamingSendMode === "steer" ? t("input.steerActionTitle") : t("input.followUpActionTitle")}
                className={
                  streamingSendMode === "steer"
                    ? ((value.trim() || attachedImages.length) && !isSubmitting ? styles.steerButtonActive : styles.steerButtonDisabled)
                    : ((value.trim() || attachedImages.length) && !isSubmitting ? styles.followUpButtonActive : styles.followUpButtonDisabled)
                }
              >
                {streamingSendMode === "steer" ? (
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 1 L9 5 L5 9" /><line x1="1" y1="5" x2="9" y2="5" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <line x1="5" y1="1" x2="5" y2="6" /><polyline points="2.5 3.5 5 1 7.5 3.5" />
                    <line x1="2" y1="9" x2="8" y2="9" />
                  </svg>
                )}
                <span className={styles.actionLabel}>{t(streamingSendMode === "steer" ? "input.steer" : "input.followUp")}</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={isSubmitting || (!value.trim() && !attachedImages.length)}
              aria-label={t("input.send")}
              className={(value.trim() || attachedImages.length) && !isSubmitting ? styles.sendButtonActive : styles.sendButtonDisabled}
              onMouseDown={(e) => { if (value.trim() || attachedImages.length) e.currentTarget.style.transform = "scale(0.97)"; }}
              onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
              <span className={styles.actionLabel}>{t("input.send")}</span>
            </button>
          )}
          </div>
        </div>

        {/* Bottom bar: left | center (context) | right */}
        <div className={styles.bottomBar}>

          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          <div className={styles.bottomBarLeft}>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming || isSubmitting}
              title={t("input.attachImage")}
              aria-label={t("input.attachImage")}
              className={isStreaming || isSubmitting ? styles.attachButtonDisabled : styles.attachButtonEnabled}
              style={{ color: attachedImages.length ? "var(--accent)" : "var(--text-muted)" }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
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
              modelOptions={modelOptions}
              modelsByProvider={modelsByProvider}
              currentName={currentName}
              model={model}
              isStreaming={isStreaming}
              onModelChange={onModelChange}
            />
          </div>

          <span className={styles.keyboardHint}>{t("input.keyboardHint")}</span>

          {!isStreaming && (
            <button
              type="button"
              className={`${styles.mobileToolsButton} ${mobileToolsOpen ? styles.mobileToolsButtonActive : ""}`}
              onClick={() => setMobileToolsOpen((open) => !open)}
              aria-label={t("input.moreControls")}
              aria-expanded={mobileToolsOpen}
              aria-controls="composer-secondary-tools"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2" fill="var(--bg)" />
                <line x1="4" y1="17" x2="20" y2="17" /><circle cx="15" cy="17" r="2" fill="var(--bg)" />
              </svg>
            </button>
          )}

          {/* RIGHT: thinking + tools preset + compact + sound (idle) | Stop + sound (streaming) */}
          <div
            id="composer-secondary-tools"
            className={`${styles.bottomBarRight} ${mobileToolsOpen ? styles.bottomBarRightMobileOpen : ""} ${isStreaming ? styles.bottomBarRightStreaming : ""}`}
          >
            <button
              type="button"
              onClick={toggleExpanded}
              className={styles.expandButton}
              aria-expanded={expanded}
              aria-label={expanded ? t("input.collapseComposer") : t("input.expandComposer")}
              title={expanded ? t("input.collapseComposer") : t("input.expandComposer")}
            >
              {expanded ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M8 3v5H3M16 21v-5h5M3 8l5-5M21 16l-5 5" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M8 3H3v5M16 21h5v-5M3 8l5-5M21 16l-5 5" />
                </svg>
              )}
            </button>
            <ThinkingSelector
              thinkingLevel={thinkingLevel}
              thinkingLevelMap={thinkingLevelMap}
              availableThinkingLevels={availableThinkingLevels}
              isStreaming={isStreaming}
              onThinkingLevelChange={onThinkingLevelChange}
            />
            <ToolPresetSelector
              toolPreset={toolPreset}
              isStreaming={isStreaming}
              onToolPresetChange={onToolPresetChange}
            />

            {!isStreaming && onCompact && (
              <div className={styles.compactControls}>
                {autoCompactionEnabled !== null && autoCompactionEnabled !== undefined && onAutoCompactionChange && (
                  <button
                    type="button"
                    onClick={() => onAutoCompactionChange(!autoCompactionEnabled)}
                    disabled={isCompacting || autoCompactionUpdating}
                    aria-label={`${t("chat.autoCompact")} ${autoCompactionEnabled ? t("chat.on") : t("chat.off")}`}
                    aria-pressed={autoCompactionEnabled}
                    title={autoCompactionEnabled ? t("chat.autoCompactOnTitle") : t("chat.autoCompactOffTitle")}
                    className={autoCompactionEnabled ? styles.autoCompactButtonOn : styles.autoCompactButtonOff}
                  >
                    <span className={styles.autoCompactDot} aria-hidden />
                    {t("chat.autoCompactShort")}
                  </button>
                )}
                <div className={styles.compactWrapper}>
                  {compactError && (
                    <div className={styles.compactErrorTooltip}>
                      {compactError}
                    </div>
                  )}
                  <button
                    onClick={isCompacting ? onAbortCompaction : onCompact}
                    className={isCompacting ? styles.compactButtonCompacting : styles.compactButtonIdle}
                    title={isCompacting ? t("chat.stopCompaction") : t("chat.compactTitle")}
                  >
                    {isCompacting ? (
                      <><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg>{t("chat.compacting")}</>
                    ) : (
                      <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                        <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                      </svg>{t("chat.compactNow")}</>
                    )}
                  </button>
                </div>
              </div>
            )}

            {isStreaming && (
              <button
                type="button"
                onClick={onAbort}
                title={t("input.stopTitle")}
                className={styles.stopButton}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                {t("input.stop")}
              </button>
            )}

            {onSoundToggle !== undefined && (
              <button
                type="button"
                onClick={onSoundToggle}
                aria-label={soundEnabled ? t("input.soundOnTitle") : t("input.soundOffTitle")}
                title={soundEnabled ? t("input.soundOnTitle") : t("input.soundOffTitle")}
                className={soundEnabled ? styles.soundButtonEnabled : styles.soundButtonDisabled}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = soundEnabled ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.opacity = soundEnabled ? "1" : "0.55";
                }}
              >
                {soundEnabled ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                )}
              </button>
            )}
          </div>

        </div>
      </div>
    </div>
  );
});
