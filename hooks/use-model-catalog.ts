"use client";

import { useState, useEffect } from "react";
import type { ModelCatalogEntry } from "@/lib/model-catalog-types";

export interface ModelRef {
  provider: string;
  modelId: string;
}

/**
 * Loads the model catalog (/api/models): display names, selectable list,
 * thinking-level metadata, and — for new sessions — the default model
 * pre-selection. `overrideSetNewSessionModel` lets the caller intercept the
 * selection (parallel panes share one selection through the parent).
 */
export function useModelCatalog(
  isNew: boolean,
  modelsRefreshKey: number | undefined,
  overrideSetNewSessionModel?: (model: ModelRef | null) => void,
  sessionId?: string | null,
  cwd?: string | null,
) {
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelCatalogEntry[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModelState] = useState<ModelRef | null>(null);
  const setNewSessionModel = overrideSetNewSessionModel ?? setNewSessionModelState;

  useEffect(() => {
    if (!sessionId && !cwd) return;
    let cancelled = false;
    const controller = new AbortController();
    const request = sessionId
      ? fetch(`/api/models?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      : fetch("/api/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd }),
          signal: controller.signal,
        });
    request.then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then((d: { models: Record<string, string>; modelList?: ModelCatalogEntry[]; defaultModel?: ModelRef | null; thinkingLevels?: Record<string, string[]>; thinkingLevelMaps?: Record<string, Record<string, string | null>> }) => {
      if (cancelled) return;
      setModelNames(d.models);
      if (d.thinkingLevels) setModelThinkingLevels(d.thinkingLevels);
      if (d.thinkingLevelMaps) setModelThinkingLevelMaps(d.thinkingLevelMaps);
      if (d.modelList) {
        setModelList(d.modelList);
        if (isNew && d.modelList.length > 0) {
          const def = d.defaultModel;
          const match = def && d.modelList.find((m) => m.id === def.modelId && m.provider === def.provider);
          const selected = match
            ? { provider: match.provider, modelId: match.id }
            : { provider: d.modelList[0].provider, modelId: d.modelList[0].id };
          setNewSessionModel(selected);
        }
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isNew, modelsRefreshKey, setNewSessionModel, sessionId, cwd]);

  return { modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, setNewSessionModel };
}
