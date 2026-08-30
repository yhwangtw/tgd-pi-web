"use client";

import React, { useState, useRef, useEffect, useId, useMemo, useCallback } from "react";
import { BadgeCheck, Check, ChevronDown, Cpu, Pin, Search } from "lucide-react";
import { DialogShell } from "@/components/ui/DialogShell";
import { useI18n } from "@/lib/i18n";
import type { ModelCatalogCost } from "@/lib/model-catalog-types";
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
  onModelChange?: (provider: string, modelId: string) => void;
  className?: string;
}

export function ModelSelector({
  modelOptions,
  modelsByProvider,
  currentName,
  model,
  isStreaming,
  onModelChange,
  className,
}: ModelSelectorProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [query, setQuery] = useState("");
  const [recentRefs, setRecentRefs] = useState<ModelPreferenceRef[]>([]);
  const [pinnedRefs, setPinnedRefs] = useState<ModelPreferenceRef[]>([]);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelId = useId();
  const flatOptions = useMemo(
    () => modelsByProvider.flatMap((group) => group.options),
    [modelsByProvider],
  );

  const selectedIndex = Math.max(0, flatOptions.findIndex(
    (option) => option.modelId === model?.modelId && option.provider === model?.provider,
  ));

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

  const focusOption = (index: number, moveFocus = true) => {
    if (!flatOptions.length) return;
    const nextIndex = (index + flatOptions.length) % flatOptions.length;
    setActiveIndex(nextIndex);
    if (moveFocus) requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
  };

  const openMenu = (button: HTMLButtonElement, preferredIndex = selectedIndex, moveFocus = false) => {
    if (isMobile) {
      // Keep an explicit launcher focus target so DialogShell can always return
      // focus after pointer, keyboard, or programmatic opens.
      button.focus();
    } else {
      const nextRect = button.getBoundingClientRect();
      setRect({ top: nextRect.top, left: nextRect.left, width: nextRect.width });
    }
    setQuery("");
    setOpen(true);
    if (!isMobile) focusOption(preferredIndex, moveFocus);
  };

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const rememberModel = useCallback((option: ModelOption) => {
    setRecentRefs((current) => {
      const next = rememberRecentModel(current, option);
      saveModelPreferenceRefs(window.localStorage, MODEL_RECENT_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const selectModel = useCallback((option: ModelOption, restoreFocus = true) => {
    const isActive = option.modelId === model?.modelId && option.provider === model?.provider;
    rememberModel(option);
    closeMenu(restoreFocus && !isMobile);
    if (!isActive) onModelChange?.(option.provider, option.modelId);
  }, [closeMenu, isMobile, model?.modelId, model?.provider, onModelChange, rememberModel]);

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
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchesQuery = useCallback((option: ModelOption) => {
    if (!normalizedQuery) return true;
    return `${option.name} ${option.modelId} ${option.provider}`.toLocaleLowerCase().includes(normalizedQuery);
  }, [normalizedQuery]);
  const pinnedOptions = pinnedRefs
    .map((ref) => optionByKey.get(modelPreferenceKey(ref)))
    .filter((option): option is ModelOption => Boolean(option))
    .filter(matchesQuery);
  const recentOptions = recentRefs
    .filter((ref) => !pinnedKeys.has(modelPreferenceKey(ref)))
    .map((ref) => optionByKey.get(modelPreferenceKey(ref)))
    .filter((option): option is ModelOption => Boolean(option))
    .filter(matchesQuery);
  const quickOptionKeys = new Set(
    [...pinnedOptions, ...recentOptions].map(modelPreferenceKey),
  );
  const filteredGroups = modelsByProvider
    .map((group) => ({
      ...group,
      options: group.options.filter((option) => matchesQuery(option) && !quickOptionKeys.has(modelPreferenceKey(option))),
    }))
    .filter((group) => group.options.length > 0);
  const hasMobileResults = pinnedOptions.length > 0 || recentOptions.length > 0 || filteredGroups.length > 0;

  const renderMobileModel = (option: ModelOption) => {
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
          onClick={() => selectModel(option, false)}
        >
          <span className={styles.mobileModelLeading} aria-hidden>
            {isActive ? <Check size={16} strokeWidth={2.2} /> : <Cpu size={16} strokeWidth={1.8} />}
          </span>
          <span className={styles.mobileModelCopy}>
            <span className={styles.mobileModelName}>{option.name}</span>
            <span className={styles.mobileModelMeta}>
              <span>{option.provider}</span>
              <span aria-hidden>·</span>
              <span className={option.available === false ? styles.modelUnavailable : styles.modelAvailable}>
                <BadgeCheck size={12} aria-hidden />
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
          <Pin size={16} strokeWidth={1.8} fill={isPinned ? "currentColor" : "none"} aria-hidden />
        </button>
      </div>
    );
  };

  if (!modelOptions.length || !currentName || !onModelChange) return null;

  return (
    <div ref={dropdownRef} className={`${styles.root} ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup={isMobile ? "dialog" : "listbox"}
        aria-controls={open ? panelId : undefined}
        onClick={(e) => {
          if (open) closeMenu();
          else openMenu(e.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openMenu(
            event.currentTarget,
            event.key === "ArrowUp" ? flatOptions.length - 1 : selectedIndex,
            true,
          );
        }}
        disabled={isStreaming}
        className={`${styles.trigger} ${open ? styles.triggerOpen : ""}`}
      >
        <Cpu size={13} strokeWidth={1.8} aria-hidden />
        <span className={styles.triggerLabel}>{currentName}</span>
        <ChevronDown className={styles.chevron} size={13} strokeWidth={1.8} aria-hidden />
      </button>
      {open && isMobile && (
        <DialogShell
          open
          title={t("model.choose")}
          description={t("model.chooseHint")}
          onClose={() => closeMenu(false)}
          initialFocusRef={searchRef}
          bodyClassName={styles.modelSheetBody}
          mobileMode="sheet"
        >
          <div className={styles.modelSheetSearch}>
            <Search size={17} strokeWidth={1.8} aria-hidden />
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
          {pinnedOptions.length > 0 && (
            <section className={styles.mobileModelSection} aria-labelledby={`${panelId}-pinned`}>
              <h3 id={`${panelId}-pinned`}>{t("model.pinned")}</h3>
              <div className={styles.mobileModelList}>{pinnedOptions.map(renderMobileModel)}</div>
            </section>
          )}
          {recentOptions.length > 0 && (
            <section className={styles.mobileModelSection} aria-labelledby={`${panelId}-recent`}>
              <h3 id={`${panelId}-recent`}>{t("model.recent")}</h3>
              <div className={styles.mobileModelList}>{recentOptions.map(renderMobileModel)}</div>
            </section>
          )}
          {filteredGroups.map((group) => (
            <section className={styles.mobileModelSection} key={group.provider} aria-labelledby={`${panelId}-${group.provider}`}>
              <h3 id={`${panelId}-${group.provider}`}>{group.provider}</h3>
              <div className={styles.mobileModelList}>{group.options.map(renderMobileModel)}</div>
            </section>
          ))}
          {!hasMobileResults && <p className={styles.modelNoResults}>{t("model.noResults")}</p>}
        </DialogShell>
      )}
      {open && !isMobile && rect && (() => {
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const bottom = viewportHeight - rect.top + 6;
        const maxH = Math.max(120, Math.min(rect.top - 8, viewportHeight * 0.6));
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - 208));
        return (
          <div
            ref={panelRef}
            id={panelId}
            className={`${styles.panel} ${styles.panelFixed} ${styles.modelPanel}`}
            style={{ bottom, left, width: "max-content", maxHeight: maxH }}
            role="listbox"
            aria-label={t("model.selectorLabel")}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusOption(activeIndex + 1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                focusOption(activeIndex - 1);
              } else if (event.key === "Home") {
                event.preventDefault();
                focusOption(0);
              } else if (event.key === "End") {
                event.preventDefault();
                focusOption(flatOptions.length - 1);
              } else if (event.key === "Tab") {
                closeMenu();
              }
            }}
          >
            {modelsByProvider.map((group, gi) => (
              <div key={group.provider}>
                {modelsByProvider.length > 1 && (
                  <div className={`${styles.providerLabel} ${gi > 0 ? styles.providerLabelBordered : ""}`}>
                    {group.provider}
                  </div>
                )}
                {group.options.map((opt) => {
                  const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                  const optionIndex = flatOptions.findIndex(
                    (candidate) => candidate.modelId === opt.modelId && candidate.provider === opt.provider,
                  );
                  return (
                    <button
                      ref={(node) => { optionRefs.current[optionIndex] = node; }}
                      key={`${opt.provider}:${opt.modelId}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      tabIndex={optionIndex === activeIndex ? 0 : -1}
                      onFocus={() => setActiveIndex(optionIndex)}
                      onClick={() => {
                        selectModel(opt);
                      }}
                      className={`${styles.option} ${styles.modelOption} ${isActive ? styles.optionActive : ""}`}
                    >
                      {isActive
                        ? <Check className={styles.check} size={12} strokeWidth={2.2} aria-hidden />
                        : <span className={styles.checkSpacer} />}
                      <span className={styles.desktopModelCopy}>
                        <span className={styles.desktopModelName}>{opt.name}</span>
                        <span className={styles.desktopModelMeta}>
                          {opt.contextWindow ? formatContextWindow(opt.contextWindow) : opt.provider}
                          {opt.cost ? ` · ${formatModelCost(opt.cost)}` : ""}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

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
