/** Session selection and the immutable settings prepared for the current request. */
export interface GenerationSelection {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface GenerationSettingsState {
  selected: GenerationSelection | null;
  active: GenerationSelection | null;
  revision: number;
  pending: boolean;
  restarting: boolean;
  runId: string | null;
  canRestart: boolean;
}

export function sameGenerationSelection(a: GenerationSelection | null, b: GenerationSelection | null): boolean {
  return a?.provider === b?.provider && a?.modelId === b?.modelId && a?.thinkingLevel === b?.thinkingLevel;
}
