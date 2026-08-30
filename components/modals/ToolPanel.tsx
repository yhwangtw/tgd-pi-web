"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/lib/i18n";
import {
  TOOL_PRESET_DEFAULT,
  TOOL_PRESET_FULL,
  TOOL_PRESET_NONE,
  inferToolSelectionMode,
  type ToolSelectionMode,
} from "@/lib/tool-selection";
import styles from "./ToolPanel.module.css";

export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export type ToolPreset = ToolSelectionMode;
export const PRESET_NONE: string[] = TOOL_PRESET_NONE;
export const PRESET_DEFAULT: string[] = [...TOOL_PRESET_DEFAULT];
export const PRESET_FULL: string[] = [...TOOL_PRESET_FULL];

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  return inferToolSelectionMode(tools.filter((tool) => tool.active).map((tool) => tool.name));
}

interface Props {
  tools: ToolEntry[];
  onPreset: (preset: ToolPreset, toolNames: string[]) => void;
  onClose: () => void;
}

const PRESETS: { id: Exclude<ToolPreset, "inherit" | "custom" | "plan">; labelKey: "tools.level.off" | "tools.level.low" | "tools.level.high"; descKey: "tools.none" | "tools.defaultDescription" | "tools.fullDescription"; tools: string[] }[] = [
  { id: "none", labelKey: "tools.level.off", descKey: "tools.none", tools: PRESET_NONE },
  { id: "default", labelKey: "tools.level.low", descKey: "tools.defaultDescription", tools: PRESET_DEFAULT },
  { id: "full", labelKey: "tools.level.high", descKey: "tools.fullDescription", tools: PRESET_FULL },
];

export function ToolPanel({ tools, onPreset, onClose }: Props) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const current = getPresetFromTools(tools);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const currentIndex = PRESETS.findIndex(p => p.id === current);

  return (
    <div ref={panelRef} className={styles.panel}>
      {/* Segmented control */}
      <div className={styles.segmentedControl} role="group" aria-label={t("tools.accessLevel")}>
        {PRESETS.map((preset) => {
          const isActive = current === preset.id;
          return (
            <button
              type="button"
              key={preset.id}
              onClick={() => { onPreset(preset.id, preset.tools); onClose(); }}
              className={`${styles.presetBtn} ${isActive ? styles.presetBtnActive : ""}`}
              aria-pressed={isActive}
            >
              {t(preset.labelKey)}
            </button>
          );
        })}
      </div>

      {/* Description of current selection */}
      <div className={styles.description}>
        {currentIndex >= 0 ? t(PRESETS[currentIndex].descKey) : ""}
        {current === "none" && <span> — {t("tools.noneHint")}</span>}
      </div>

      {/* Track bar */}
      <div className={styles.trackBar}>
        {PRESETS.map((_, i) => (
          <div
            key={i}
            className={`${styles.trackSegment} ${i <= currentIndex ? styles.trackSegmentActive : ""}`}
          />
        ))}
      </div>

      <div className={styles.note}>
        {t("tools.nextTurn")}
      </div>
    </div>
  );
}
