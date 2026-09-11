"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ModelCatalogEntry } from "@/lib/model-catalog-types";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export type ModelCatalogStatus = "loading" | "ready" | "empty" | "error";
export interface ModelCatalogDiagnostic { type: string; message: string; }

interface CatalogSnapshot {
  sourceKey: string;
  status: ModelCatalogStatus;
  error: string | null;
  models: Record<string, string>;
  modelList: ModelCatalogEntry[];
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  diagnostics: ModelCatalogDiagnostic[];
}

const EMPTY_CATALOG: Pick<CatalogSnapshot, "models" | "modelList" | "thinkingLevels" | "thinkingLevelMaps" | "diagnostics"> = {
  models: {}, modelList: [], thinkingLevels: {}, thinkingLevelMaps: {}, diagnostics: [],
};

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
  // Tag both the data and selection with their source. A source change must
  // stop exposing the previous project's models during render, before effects.
  const sourceKey = sessionId ? `session:${sessionId}:${cwd ?? ""}` : cwd ? `cwd:${cwd}` : "";
  const sourceRef = useRef(sourceKey);
  sourceRef.current = sourceKey;
  const [snapshot, setSnapshot] = useState<CatalogSnapshot>({
    ...EMPTY_CATALOG, sourceKey: "", status: "empty", error: null,
  });
  const [selection, setSelection] = useState<{ sourceKey: string; model: ModelRef | null }>({ sourceKey: "", model: null });
  const selectionRef = useRef(selection);
  const overrideRef = useRef(overrideSetNewSessionModel);
  overrideRef.current = overrideSetNewSessionModel;
  const [retryKey, setRetryKey] = useState(0);
  const retryModelCatalog = useCallback(() => setRetryKey((key) => key + 1), []);
  const setNewSessionModel = useCallback((model: ModelRef | null) => {
    if (sourceRef.current !== sourceKey) return;
    const next = { sourceKey, model };
    selectionRef.current = next;
    setSelection(next);
    overrideRef.current?.(model);
  }, [sourceKey]);

  useEffect(() => {
    if (selectionRef.current.sourceKey !== sourceKey) setNewSessionModel(null);
    if (!sourceKey) return;
    let cancelled = false;
    const controller = new AbortController();
    setSnapshot({ ...EMPTY_CATALOG, sourceKey, status: "loading", error: null });
    void (async () => {
      try {
        const response = sessionId
          ? await fetch(`/api/models?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
          : await fetch("/api/models", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ cwd }),
              signal: controller.signal,
            });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const d = await response.json() as {
          modelList?: ModelCatalogEntry[]; defaultModel?: ModelRef | null;
          thinkingLevels?: CatalogSnapshot["thinkingLevels"];
          thinkingLevelMaps?: CatalogSnapshot["thinkingLevelMaps"];
          diagnostics?: ModelCatalogDiagnostic[];
        };
        if (!Array.isArray(d.modelList)) throw new Error("Invalid model catalog");
        if (cancelled) return;
        const modelList = d.modelList.filter((model) => model.available !== false);
        const diagnostics = (Array.isArray(d.diagnostics) ? d.diagnostics : [])
          .filter((item) => typeof item?.type === "string" && typeof item?.message === "string");
        setSnapshot({
          sourceKey, status: modelList.length ? "ready" : "empty", error: null,
          models: Object.fromEntries(modelList.map((model) => [`${model.provider}:${model.id}`, model.name])),
          modelList, thinkingLevels: d.thinkingLevels ?? {}, thinkingLevelMaps: d.thinkingLevelMaps ?? {}, diagnostics,
        });
        if (isNew) {
          const previous = selectionRef.current.sourceKey === sourceKey ? selectionRef.current.model : null;
          const find = (ref: ModelRef | null | undefined) => ref && modelList.find((model) => model.id === ref.modelId && model.provider === ref.provider);
          const match = find(previous) || find(d.defaultModel) || modelList[0];
          setNewSessionModel(match ? { provider: match.provider, modelId: match.id } : null);
        }
      } catch (error) {
        if (cancelled) return;
        setSnapshot({ ...EMPTY_CATALOG, sourceKey, status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isNew, modelsRefreshKey, retryKey, setNewSessionModel, sessionId, cwd, sourceKey]);

  const active = snapshot.sourceKey === sourceKey;
  const catalogStatus = !sourceKey ? "empty" : active ? snapshot.status : "loading";
  const data = active && catalogStatus === "ready" ? snapshot : EMPTY_CATALOG;
  const newSessionModel = catalogStatus === "ready" && selection.sourceKey === sourceKey ? selection.model : null;
  return {
    modelNames: data.models, modelList: data.modelList,
    modelThinkingLevels: data.thinkingLevels, modelThinkingLevelMaps: data.thinkingLevelMaps,
    newSessionModel, setNewSessionModel, catalogStatus,
    catalogError: active ? snapshot.error : null,
    catalogDiagnostics: active ? snapshot.diagnostics : EMPTY_CATALOG.diagnostics,
    retryModelCatalog,
  };
}
