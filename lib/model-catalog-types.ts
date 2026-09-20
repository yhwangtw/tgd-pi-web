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
  /** Credentials are configured; upstream account access is only known after a request. */
  available?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCatalogCost;
}
