"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import React, { useState, useRef, useEffect, useLayoutEffect, useId, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { BadgeCheck, Check, ChevronDown, Cpu, Pin, Search, RefreshCw, Settings2, TriangleAlert } from "lucide-react";
import { DialogShell } from "@/components/ui/DialogShell";
import { useI18n } from "@/lib/i18n";
import type { ModelCatalogCost } from "@/lib/model-catalog-types";
import type { ModelCatalogDiagnostic, ModelCatalogStatus } from "@/hooks/use-model-catalog";
import {
  loadModelPreferenceRefs,
  MODEL_PINNED_STORAGE_KEY,
  MODEL_RECENT_STORAGE_KEY,
  modelPreferenceKey,
  rememberRecentModel,
  saveModelPreferenceRefs,
  togglePinnedModel,
  type ModelPreferenceRef,
} from "@/lib/model-selector-prefs";
import styles from "./ComposerSelector.module.css";

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
  available?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCatalogCost;
}

interface ModelSelectorProps {
  modelOptions: ModelOption[];
  modelsByProvider: { provider: string; options: ModelOption[] }[];
  currentName: string | null;
  model?: { provider: string; modelId: string } | null;
  isStreaming: boolean;
  disabled?: boolean;
  onModelChange?: (provider: string, modelId: string) => void;
  catalogStatus?: ModelCatalogStatus;
  catalogError?: string | null;
  catalogDiagnostics?: ModelCatalogDiagnostic[];
  onRetry?: () => void;
  onOpenModels?: () => void;
  onOpen?: () => void;
  className?: string;
}

export const ModelSelector = React.memo(function ModelSelector({
  modelOptions,
  modelsByProvider,
  currentName,
  model,
  disabled = false,
  onModelChange,
  catalogStatus,
  catalogError,
  catalogDiagnostics = [],
  onRetry,
  onOpenModels,
  onOpen,
  className,
}: ModelSelectorProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [query, setQuery] = useState("");
  const [recentRefs, setRecentRefs] = useState<ModelPreferenceRef[]>([]);
  const [pinnedRefs, setPinnedRefs] = useState<ModelPreferenceRef[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const status = catalogStatus ?? (modelOptions.length ? "ready" : "empty");
  const needsRecovery = status !== "ready" || !modelOptions.length;
  const useDialog = isMobile || needsRecovery;

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 700px)");
    const update = () => setIsMobile(media?.matches ?? false);
    update();
    media?.addEventListener?.("change", update);
    return () => media?.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    setRecentRefs(loadModelPreferenceRefs(window.localStorage, MODEL_RECENT_STORAGE_KEY));
    setPinnedRefs(loadModelPreferenceRefs(window.localStorage, MODEL_PINNED_STORAGE_KEY));
  }, []);

  const openMenu = (button: HTMLButtonElement) => {
    if (disabled) return;
    onOpen?.();
    button.focus();
    setQuery("");
    setOpen(true);
  };

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useLayoutEffect(() => {
    if (!open || useDialog) return;
    const anchor = triggerRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const place = () => {
      const edge = 8;
      const gap = 6;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const rect = anchor.getBoundingClientRect();
      panel.style.maxWidth = `${Math.max(0, width - edge * 2)}px`;
      const above = Math.max(0, rect.top - y - edge - gap);
      const below = Math.max(0, y + height - rect.bottom - edge - gap);
      const preferredHeight = Math.min(panel.scrollHeight, height * 0.6);
      const upwards = above >= preferredHeight || above >= below;
      panel.style.maxHeight = `${Math.min(height * 0.6, upwards ? above : below)}px`;
      const bounds = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(x + edge, Math.min(rect.left, x + width - edge - bounds.width))}px`;
      panel.style.top = `${Math.max(y + edge, Math.min(upwards ? rect.top - gap - bounds.height : rect.bottom + gap, y + height - edge - bounds.height))}px`;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    searchRef.current?.focus();
    // The composer moves when controls, drafts or either sidebar change size.
    // Observe its ancestors as well as viewport changes, without a polling loop.
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    for (let element: HTMLElement | null = anchor; element; element = element.parentElement) observer?.observe(element);
    observer?.observe(panel);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
    };
  }, [open, useDialog]);

  useEffect(() => {
    // A recovered catalog changes the recovery dialog into a picker. Close the old
    // surface, or close options when the caller explicitly locks model changes.
    setOpen(false);
    setQuery("");
  }, [needsRecovery, disabled]);

  const rememberModel = useCallback((option: ModelOption) => {
    setRecentRefs((current) => {
      const next = rememberRecentModel(current, option);
      saveModelPreferenceRefs(window.localStorage, MODEL_RECENT_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const selectModel = useCallback((option: ModelOption, restoreFocus = true) => {
    if (disabled || option.available === false) return;
    const isActive = option.modelId === model?.modelId && option.provider === model?.provider;
    rememberModel(option);
    closeMenu(restoreFocus && !isMobile);
    if (!isActive) onModelChange?.(option.provider, option.modelId);
  }, [closeMenu, disabled, isMobile, model?.modelId, model?.provider, onModelChange, rememberModel]);

  const togglePin = useCallback((option: ModelOption) => {
    setPinnedRefs((current) => {
      const next = togglePinnedModel(current, option);
      saveModelPreferenceRefs(window.localStorage, MODEL_PINNED_STORAGE_KEY, next);
      return next;
    });
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        panelRef.current && !panelRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu(true);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeMenu, open]);

  const optionByKey = useMemo(
    () => new Map(modelOptions.map((option) => [modelPreferenceKey(option), option])),
    [modelOptions],
  );
  const pinnedKeys = useMemo(
    () => new Set(pinnedRefs.map(modelPreferenceKey)),
    [pinnedRefs],
  );
  const searchTextByKey = useMemo(() => new Map(modelOptions.map((option) => [
    modelPreferenceKey(option), `${option.name} ${option.modelId} ${option.provider}`.toLocaleLowerCase(),
  ])), [modelOptions]);
  const currentModelKey = model ? modelPreferenceKey(model) : null;
  const { currentOptions, pinnedOptions, recentOptions, filteredGroups } = useMemo(() => {
    // Most composer renders happen while typing with this menu closed. Do not
    // filter the catalog or create thousands of hidden option elements then.
    if (!open || needsRecovery) return { currentOptions: [], pinnedOptions: [], recentOptions: [], filteredGroups: [] };
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matchesQuery = (option: ModelOption) => !normalizedQuery
      || (searchTextByKey.get(modelPreferenceKey(option)) ?? "").includes(normalizedQuery);
    const isCurrent = (option: ModelOption) => modelPreferenceKey(option) === currentModelKey;
    const currentOption = currentModelKey ? optionByKey.get(currentModelKey) : undefined;
    const currentOptions = currentOption && matchesQuery(currentOption) ? [currentOption] : [];
    const pinnedOptions = pinnedRefs
      .map((ref) => optionByKey.get(modelPreferenceKey(ref)))
      .filter((option): option is ModelOption => Boolean(option))
      .filter((option) => matchesQuery(option) && !isCurrent(option));
    const recentOptions = recentRefs
      .filter((ref) => !pinnedKeys.has(modelPreferenceKey(ref)))
      .map((ref) => optionByKey.get(modelPreferenceKey(ref)))
      .filter((option): option is ModelOption => Boolean(option))
      .filter((option) => matchesQuery(option) && !isCurrent(option));
    const quickOptionKeys = new Set([...currentOptions, ...pinnedOptions, ...recentOptions].map(modelPreferenceKey));
    const filteredGroups = modelsByProvider
      .map((group) => ({ ...group, options: group.options.filter((option) => matchesQuery(option) && !quickOptionKeys.has(modelPreferenceKey(option))) }))
      .filter((group) => group.options.length > 0);
    return { currentOptions, pinnedOptions, recentOptions, filteredGroups };
  }, [open, needsRecovery, query, currentModelKey, optionByKey, pinnedRefs, recentRefs, pinnedKeys, modelsByProvider, searchTextByKey]);
  const hasResults = currentOptions.length > 0 || pinnedOptions.length > 0 || recentOptions.length > 0 || filteredGroups.length > 0;
  const hasRejectedModels = useMemo(() => modelOptions.some((option) => option.available === false), [modelOptions]);

  const renderModel = (option: ModelOption) => {
    const identity = modelPreferenceKey(option);
    const isPinned = pinnedKeys.has(identity);
    const isActive = option.modelId === model?.modelId && option.provider === model?.provider;
    return (
      <div
        key={identity}
        className={`${styles.mobileModelRow} ${isActive ? styles.mobileModelRowActive : ""}`}
      >
        <button
          type="button"
          className={styles.mobileModelSelect}
          aria-current={isActive ? "true" : undefined}
          aria-disabled={option.available === false || undefined}
          title={option.available === false ? t("model.rejected") : undefined}
          data-model-choice
          onClick={() => selectModel(option)}
        >
          <span className={styles.mobileModelLeading} aria-hidden>
            {isActive ? <Check size={UI_ICON_SIZE.compact} /> : <Cpu size={UI_ICON_SIZE.compact} />}
          </span>
          <span className={styles.mobileModelCopy}>
            <span className={styles.mobileModelName}>{option.name}</span>
            <span className={styles.mobileModelMeta}>
              <span>{option.provider}</span>
              <span aria-hidden>·</span>
              <span className={option.available === false ? styles.modelUnavailable : styles.modelAvailable}>
                <BadgeCheck size={UI_ICON_SIZE.inline} aria-hidden />
                {t(option.available === false ? "model.unavailable" : "model.available")}
              </span>
              {option.contextWindow && <><span aria-hidden>·</span><span>{formatContextWindow(option.contextWindow)}</span></>}
              {option.cost && <><span aria-hidden>·</span><span>{formatModelCost(option.cost)}</span></>}
            </span>
          </span>
        </button>
        <button
          type="button"
          className={`${styles.mobileModelPin} ${isPinned ? styles.mobileModelPinActive : ""}`}
          aria-pressed={isPinned}
          aria-label={t(isPinned ? "model.unpin" : "model.pin")}
          title={t(isPinned ? "model.unpin" : "model.pin")}
          onClick={() => togglePin(option)}
        >
          <Pin size={UI_ICON_SIZE.compact} fill={isPinned ? "currentColor" : "none"} aria-hidden />
        </button>
      </div>
    );
  };

  const statusLabel = t(status === "loading" ? "model.catalogLoading" : status === "error" ? "model.catalogError" : "model.catalogEmpty");
  const triggerLabel = currentName || model?.modelId || (needsRecovery ? statusLabel : t("model.choose"));
  const refreshRejected = hasRejectedModels && onRetry ? (
    <button type="button" className={styles.catalogAction} onClick={() => { closeMenu(); onRetry(); }}>
      <RefreshCw size={UI_ICON_SIZE.compact} aria-hidden />{t("model.recheck")}
    </button>
  ) : null;

  const pickerContent = open && !needsRecovery ? (
    <div onKeyDown={(event) => {
      const target = event.target as HTMLElement;
      const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-model-choice]")];
      const index = choices.indexOf(target as HTMLButtonElement);
      if (target !== searchRef.current && index < 0) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      if (target === searchRef.current && (event.key === "Home" || event.key === "End")) return;
      if (!choices.length) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
        : event.key === "ArrowDown" ? (index + 1) % choices.length
          : (index < 0 ? choices.length - 1 : (index - 1 + choices.length) % choices.length);
      choices[next]?.focus();
    }}>
          <div className={styles.modelSheetSearch}>
            <Search size={UI_ICON_SIZE.control} aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("model.searchLabel")}
              placeholder={t("model.searchPlaceholder")}
              autoComplete="off"
            />
          </div>
          {currentOptions.length > 0 && (
            <section className={styles.mobileModelSection} aria-labelledby={`${panelId}-current`}>
              <h3 id={`${panelId}-current`}>{t("model.current")}</h3>
              <div className={styles.mobileModelList}>{currentOptions.map(renderModel)}</div>
            </section>
          )}
          {pinnedOptions.length > 0 && (
            <section className={styles.mobileModelSection} aria-labelledby={`${panelId}-pinned`}>
              <h3 id={`${panelId}-pinned`}>{t("model.pinned")}</h3>
              <div className={styles.mobileModelList}>{pinnedOptions.map(renderModel)}</div>
            </section>
          )}
          {recentOptions.length > 0 && (
            <section className={styles.mobileModelSection} aria-labelledby={`${panelId}-recent`}>
              <h3 id={`${panelId}-recent`}>{t("model.recent")}</h3>
              <div className={styles.mobileModelList}>{recentOptions.map(renderModel)}</div>
            </section>
          )}
          {filteredGroups.map((group) => (
            <section className={styles.mobileModelSection} key={group.provider} aria-labelledby={`${panelId}-${group.provider}`}>
              <h3 id={`${panelId}-${group.provider}`}>{group.provider}</h3>
              <div className={styles.mobileModelList}>{group.options.map(renderModel)}</div>
            </section>
          ))}
          {!hasResults && <p className={styles.modelNoResults}>{t("model.noResults")}</p>}
          {refreshRejected}
    </div>
  ) : null;

  return (
    <div ref={dropdownRef} className={`${styles.root} ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open && !useDialog ? panelId : undefined}
        aria-label={`${t("model.selectorLabel")}: ${triggerLabel}${needsRecovery && triggerLabel !== statusLabel ? ` — ${statusLabel}` : ""}`}
        title={needsRecovery ? `${triggerLabel} — ${statusLabel}` : triggerLabel}
        data-testid="model-selector-trigger"
        data-catalog-status={status}
        onClick={(e) => {
          if (open) closeMenu();
          else openMenu(e.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openMenu(event.currentTarget);
        }}
        disabled={disabled || (!needsRecovery && !onModelChange)}
        className={`${styles.trigger} ${open ? styles.triggerOpen : ""}`}
      >
        {status === "loading"
          ? <RefreshCw size={UI_ICON_SIZE.compact} aria-hidden />
          : needsRecovery ? <TriangleAlert size={UI_ICON_SIZE.compact} aria-hidden /> : <Cpu size={UI_ICON_SIZE.compact} aria-hidden />}
        <span className={styles.triggerLabel}>{model?.provider ? triggerLabel.replace(` (${model.provider})`, "") : triggerLabel}</span>
        <ChevronDown className={styles.chevron} size={UI_ICON_SIZE.compact} aria-hidden />
      </button>
      {open && needsRecovery && (
        <DialogShell
          open
          title={t("model.choose")}
          description={status === "loading" ? undefined : t(status === "error" ? "model.catalogErrorHint" : "model.catalogEmptyHint")}
          onClose={() => closeMenu(false)}
          mobileMode="sheet"
          placement="center"
        >
          <div id={panelId} className={styles.catalogRecovery}>
            <p role="status" aria-live="polite" className={styles.catalogStatus}>{statusLabel}</p>
            {catalogError && <p className={styles.catalogDetail}>{catalogError}</p>}
            {catalogDiagnostics.length > 0 && (
              <ul className={styles.catalogDiagnostics}>
                {catalogDiagnostics.map((diagnostic, index) => <li key={`${diagnostic.type}:${index}`}>{diagnostic.message}</li>)}
              </ul>
            )}
            <div className={styles.catalogActions}>
              {onRetry && <button type="button" className={styles.catalogAction} disabled={status === "loading"} onClick={onRetry} data-testid="model-catalog-retry"><RefreshCw size={UI_ICON_SIZE.compact} aria-hidden />{t("model.catalogRetry")}</button>}
              {onOpenModels && <button type="button" className={styles.catalogAction} onClick={() => { closeMenu(); onOpenModels(); }} data-testid="model-catalog-configure"><Settings2 size={UI_ICON_SIZE.compact} aria-hidden />{t("model.configure")}</button>}
            </div>
          </div>
        </DialogShell>
      )}
      {open && !needsRecovery && isMobile && (
        <DialogShell
          open
          title={t("model.choose")}
          description={t("model.chooseHint")}
          onClose={() => closeMenu(false)}
          initialFocusRef={searchRef}
          bodyClassName={styles.modelSheetBody}
          mobileMode="sheet"
          placement="center"
        >
          {pickerContent}
        </DialogShell>
      )}
      {open && !needsRecovery && !isMobile && createPortal(
          <div
            ref={panelRef}
            className={`${styles.panel} ${styles.panelFixed} ${styles.modelPanel}`}
            data-testid="model-selector-popover"
            id={panelId}
            role="dialog"
            aria-label={t("model.choose")}
            onBlur={(event) => {
              const next = event.relatedTarget as Node | null;
              if (next && !event.currentTarget.contains(next) && !dropdownRef.current?.contains(next)) closeMenu();
            }}
          >
            {pickerContent}
          </div>,
          document.body,
      )}
    </div>
  );
});

function formatContextWindow(value: number): string {
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}M ctx`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}k ctx`;
  return `${value} ctx`;
}

function formatModelCost(cost: ModelCatalogCost): string {
  return `$${formatPrice(cost.input)} / $${formatPrice(cost.output)} · 1M`;
}

function formatPrice(value: number): string {
  if (value === 0) return "0";
  if (value >= 100) return Math.round(value).toLocaleString("en-US");
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function trimNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}
