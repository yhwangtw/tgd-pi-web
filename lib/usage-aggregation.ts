// Usage aggregation for the analytics report. Deliberately defensive: real
// session files contain assistant messages whose usage is partial — an
// errored run (e.g. a 429) records `{ input: 0, output: 0 }` with no `cost`
// at all — and one such message must not crash or NaN-poison the report.

export interface AssistantUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** What actually appears in session files — any field may be missing. */
export type PartialUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
};

export function emptyUsage(): AssistantUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function addUsage(target: AssistantUsage, src: PartialUsage | null | undefined): void {
  if (!src) return;
  const finite = (v: unknown): number => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  target.input += finite(src.input);
  target.output += finite(src.output);
  target.cacheRead += finite(src.cacheRead);
  target.cacheWrite += finite(src.cacheWrite);
  target.cost.input += finite(src.cost?.input);
  target.cost.output += finite(src.cost?.output);
  target.cost.cacheRead += finite(src.cost?.cacheRead);
  target.cost.cacheWrite += finite(src.cost?.cacheWrite);
  target.cost.total += finite(src.cost?.total);
}
