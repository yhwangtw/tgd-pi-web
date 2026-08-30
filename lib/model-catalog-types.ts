export interface ModelCatalogCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Browser-safe subset of Pi's model metadata used by model selectors. */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  /** Catalog endpoints only return usable models; kept explicit for UI clarity. */
  available?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCatalogCost;
}
