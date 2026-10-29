/** Small, explicit projection of live SDK tool/subagent activity. */
export interface ChildActivity {
  id: string;
  label: string;
  state: "pending" | "running" | "completed" | "failed" | "detached";
  target?: string;
}

export interface ActiveTool {
  id: string;
  name: string;
  label?: string;
  startedAt?: number;
  children?: ChildActivity[];
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const shortText = (value: unknown, limit: number) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit) : "";

/** pi-subagents 0.81 public Details.progress contract; unknown shapes stay unknown. */
export function subagentProgress(result: unknown): ChildActivity[] | undefined {
  if (!record(result) || !record(result.details) || !Array.isArray(result.details.progress)) return undefined;
  const children: ChildActivity[] = [];
  for (const item of result.details.progress.slice(0, 64)) {
    if (!record(item) || !Number.isSafeInteger(item.index) || Number(item.index) < 0
      || !["pending", "running", "completed", "failed", "detached"].includes(String(item.status))) continue;
    const id = String(item.index);
    if (children.some(child => child.id === id)) continue;
    const label = shortText(item.sessionName, 200) || shortText(item.agent, 200);
    if (!label) continue;
    const target = [shortText(item.currentTool, 80), shortText(item.currentPath, 500)].filter(Boolean).join(" · ");
    children.push({ id, label, state: item.status as ChildActivity["state"], ...(target ? { target } : {}) });
  }
  return children;
}

/** Preserve elapsed time across reconnects, including a different browser clock. */
export function localToolClock(tool: ActiveTool, observedAt: number, now = Date.now()): ActiveTool {
  const valid = Number.isFinite(tool.startedAt) && tool.startedAt! >= 0 && Number.isFinite(observedAt) && tool.startedAt! <= observedAt;
  return { ...tool, startedAt: valid ? now - (observedAt - tool.startedAt!) : undefined };
}
