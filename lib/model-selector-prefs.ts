export interface ModelPreferenceRef {
  provider: string;
  modelId: string;
}

export const MODEL_RECENT_STORAGE_KEY = "pi-recent-models";
export const MODEL_PINNED_STORAGE_KEY = "pi-pinned-models";

export function modelPreferenceKey(model: ModelPreferenceRef): string {
  return `${model.provider}\u0000${model.modelId}`;
}

function isModelPreferenceRef(value: unknown): value is ModelPreferenceRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModelPreferenceRef>;
  return typeof candidate.provider === "string"
    && candidate.provider.length > 0
    && typeof candidate.modelId === "string"
    && candidate.modelId.length > 0;
}

export function loadModelPreferenceRefs(storage: Storage, key: string): ModelPreferenceRef[] {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((value): value is ModelPreferenceRef => {
      if (!isModelPreferenceRef(value)) return false;
      const identity = modelPreferenceKey(value);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  } catch {
    return [];
  }
}

export function saveModelPreferenceRefs(storage: Storage, key: string, refs: ModelPreferenceRef[]): void {
  storage.setItem(key, JSON.stringify(refs));
}

export function rememberRecentModel(
  refs: ModelPreferenceRef[],
  model: ModelPreferenceRef,
  limit = 6,
): ModelPreferenceRef[] {
  const identity = modelPreferenceKey(model);
  return [model, ...refs.filter((candidate) => modelPreferenceKey(candidate) !== identity)].slice(0, limit);
}

export function togglePinnedModel(refs: ModelPreferenceRef[], model: ModelPreferenceRef): ModelPreferenceRef[] {
  const identity = modelPreferenceKey(model);
  return refs.some((candidate) => modelPreferenceKey(candidate) === identity)
    ? refs.filter((candidate) => modelPreferenceKey(candidate) !== identity)
    : [...refs, model];
}
