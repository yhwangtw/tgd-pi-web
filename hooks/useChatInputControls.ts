"use client";

import type { ToolSelectionMode } from "@/lib/tool-selection";
import type { ModelCatalogEntry } from "@/lib/model-catalog-types";

export interface ModelOption extends Omit<ModelCatalogEntry, "id"> { modelId: string; }

export interface ModelsByProviderGroup {
  provider: string;
  options: ModelOption[];
}

export type ThinkingLevel =
  | "auto"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ToolPreset = ToolSelectionMode;

export interface UseChatInputControlsOptions {
  model?: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: ModelCatalogEntry[];
  onModelChange?: (provider: string, modelId: string) => void;
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  toolPreset?: ToolPreset;
  onToolPresetChange?: (preset: ToolPreset, customNames?: string[]) => void;
}

export interface UseChatInputControlsResult {
  modelOptions: ModelOption[];
  modelsByProvider: ModelsByProviderGroup[];
  currentName: string | null;
}

/**
 * Pure derivation hook for ChatInput's model/thinking/tool-preset props.
 *
 * Responsibilities:
 * - Build `modelOptions` from `modelList` (preferred) or `modelNames` (fallback).
 * - Group options by provider, preserving insertion order.
 * - Resolve the currently selected model's display name.
 *
 * The onChange callbacks stay in the consuming component (they're prop
 * callbacks); this hook only consolidates derived data.
 */
export function useChatInputControls(
  options: UseChatInputControlsOptions
): UseChatInputControlsResult {
  const { model, modelNames, modelList } = options;

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({
        provider: m.provider,
        modelId: m.id,
        name: m.name,
        available: m.available,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: m.cost,
      }));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    }));
  })();

  // Group options by provider, preserving insertion order
  const modelsByProvider: ModelsByProviderGroup[] = [];
  for (const opt of modelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  const currentName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : modelOptions.length > 0 ? modelOptions[0].name : null;

  return { modelOptions, modelsByProvider, currentName };
}
