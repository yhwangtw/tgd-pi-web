"use client";

import React, { useState, useRef, useEffect, useId } from "react";
import { Check, Wrench } from "lucide-react";
import { TOOL_PRESETS, TOOL_PRESET_MAP } from "./chat-input-constants";
import { useI18n, type MsgKey } from "@/lib/i18n";
import type { ToolCatalogEntry, ToolSelectionMode } from "@/lib/tool-selection";
import styles from "./ComposerSelector.module.css";
import { announceComposerSelectorOpen, onAnotherComposerSelectorOpen } from "./composer-selector-coordination";

type ToolPresetLabel = typeof TOOL_PRESETS[number];

const TOOL_LABEL_KEYS: Record<ToolPresetLabel, MsgKey> = {
  inherit: "input.tools.inherit",
  off: "input.tools.off",
  plan: "input.tools.plan",
  default: "input.tools.default",
  full: "input.tools.full",
  custom: "input.tools.custom",
};

const TOOL_DESC_KEYS: Record<ToolPresetLabel, MsgKey> = {
  inherit: "input.toolsDesc.inherit",
  off: "input.toolsDesc.off",
  plan: "input.toolsDesc.plan",
  default: "input.toolsDesc.default",
  full: "input.toolsDesc.full",
  custom: "input.toolsDesc.custom",
};

interface ToolPresetSelectorProps {
  toolPreset?: ToolSelectionMode;
  availableTools?: ToolCatalogEntry[];
  customToolNames?: string[];
  isStreaming: boolean;
  presentation?: "popover" | "inline";
  onToolPresetChange?: (preset: ToolSelectionMode, customNames?: string[]) => void;
}

export function ToolPresetSelector({
  toolPreset,
  availableTools = [],
  customToolNames = [],
  isStreaming,
  presentation = "popover",
  onToolPresetChange,
}: ToolPresetSelectorProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  useEffect(() => onAnotherComposerSelectorOpen(listboxId, () => setOpen(false)), [listboxId]);
  const selectedLabel = (
    Object.entries(TOOL_PRESET_MAP)
      .find(([, value]) => value === (toolPreset ?? "inherit"))?.[0]
    ?? "inherit"
  ) as ToolPresetLabel;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!onToolPresetChange) return null;

  return (
    <div
      ref={ref}
      className={`${styles.root} ${presentation === "inline" ? styles.inlineRoot : ""}`}
      data-inline-selector-open={presentation === "inline" && open ? "true" : undefined}
    >
      <button
        ref={triggerRef}
        onClick={() => {
          if (isStreaming) return;
          if (!open) announceComposerSelectorOpen(listboxId);
          setOpen(!open);
        }}
        disabled={isStreaming}
        type="button"
        aria-label={t("input.toolsTitle")}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        title={t("input.toolsTitle")}
        className={`${styles.trigger} ${open ? styles.triggerOpen : ""}`}
      >
        <Wrench size={11} aria-hidden />
        <span>{t(TOOL_LABEL_KEYS[selectedLabel])}</span>
      </button>
      {open && (
        <div
          id={listboxId}
          className={`${styles.panel} ${presentation === "inline" ? styles.panelInline : styles.panelAbsolute} ${styles.toolPanel}`}
          role="listbox"
          aria-label={t("input.toolsTitle")}
        >
          {TOOL_PRESETS.map((lvl) => {
            const preset = TOOL_PRESET_MAP[lvl];
            const isActive = (toolPreset ?? "inherit") === preset;
            const desc = t(TOOL_DESC_KEYS[lvl]);
            return (
              <button
                key={lvl}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  if (preset === "custom") {
                    if (!isActive) onToolPresetChange("custom", customToolNames);
                    return;
                  }
                  setOpen(false);
                  if (!isActive) onToolPresetChange(preset);
                  requestAnimationFrame(() => triggerRef.current?.focus());
                }}
                className={`${styles.option} ${isActive ? styles.optionActive : ""}`}
              >
                {isActive
                  ? <Check className={styles.check} size={10} strokeWidth={2} aria-hidden />
                  : <span className={styles.checkSpacer} />}
                <span className={styles.optionLabel}>{t(TOOL_LABEL_KEYS[lvl])}</span>
                <span className={styles.description}>{desc}</span>
              </button>
            );
          })}
          {(toolPreset ?? "inherit") === "custom" && availableTools.length > 0 && (
            <div className={styles.toolChecklist} aria-label={t("input.tools.customList")}>
              {availableTools.map((tool) => {
                const checked = customToolNames.includes(tool.name);
                return (
                  <label key={tool.name} className={styles.toolCheckRow}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? customToolNames.filter((name) => name !== tool.name)
                          : [...customToolNames, tool.name];
                        onToolPresetChange("custom", next);
                      }}
                    />
                    <span className={styles.toolCheckCopy}>
                      <span className={styles.optionLabel}>{tool.label ?? tool.name}</span>
                      <span className={styles.description}>{tool.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
