import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "../pi-types";
import { AgentSessionWrapper, getResumableRpcSession, getRpcSession } from "../rpc-manager";

const savedRegistry = globalThis.__piSessions;
const wrappers: AgentSessionWrapper[] = [];
afterEach(() => { wrappers.splice(0).forEach((wrapper) => wrapper.destroy()); globalThis.__piSessions = savedRegistry; vi.useRealTimers(); });

function fixture() {
  const makeInner = (id: string) => ({ sessionId: id, sessionFile: `/fixture/${id}.jsonl`, sessionManager: {}, subscribe: vi.fn(() => vi.fn()), dispose: vi.fn() }) as unknown as AgentSessionLike;
  let active = makeInner("old");
  let before: (() => void) | undefined;
  let rebind: (() => Promise<void>) | undefined;
  let finish: (() => Promise<void>) | undefined;
  let count = 0;
  const runtime = {
    get session() { return active; }, cwd: "/fixture",
    setBeforeSessionInvalidate: (callback?: () => void) => { before = callback; },
    setRebindSession: (callback?: () => Promise<void>) => { rebind = callback; },
    fork: async () => { before?.(); active = makeInner(`next-${++count}`); await rebind?.(); await finish?.(); return { cancelled: false }; },
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentSessionRuntime;
  const wrapper = new AgentSessionWrapper(active);
  wrappers.push(wrapper);
  wrapper.bindExtensions = vi.fn().mockResolvedValue(undefined);
  const registry = new Map([["old", wrapper]]); globalThis.__piSessions = registry;
  wrapper.attachRuntime(runtime, () => undefined, (current, previous, next) => { registry.delete(previous); registry.set(next, current); });
  const cursor = wrapper.getStreamSnapshot().cursor as string;
  return { wrapper, cursor, replace: () => wrapper.send({ type: "fork", entryId: "fixture-entry" }), pause: (callback: () => Promise<void>) => { finish = callback; } };
}

describe("epoch-bound replacement stream aliases", () => {
  it("finds the same runtime after the old id is rekeyed without redirecting normal RPC or foreign cursors", async () => {
    const { wrapper, cursor, replace } = fixture();
    await replace();
    expect(getRpcSession("old")).toBeUndefined();
    expect(getRpcSession("next-1")).toBe(wrapper);
    expect(getResumableRpcSession("old", cursor)).toBe(wrapper);
    expect(getResumableRpcSession("old", "other-runtime:0")).toBeUndefined();
    expect(getResumableRpcSession("unrelated", cursor)).toBeUndefined();
    expect(getResumableRpcSession("old", cursor.replace(/:\d+$/, ":999999"))).toBeUndefined();
    expect(getResumableRpcSession("old", cursor.replace(/:\d+$/, ":"))).toBeUndefined();
  });

  it("recognizes the original cursor while replacement is unfinished, so transport can wait safely", async () => {
    const { wrapper, cursor, replace, pause } = fixture();
    let release!: () => void;
    pause(() => new Promise<void>((resolve) => { release = resolve; }));
    const replacing = replace();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(getRpcSession("old")).toBeUndefined();
    expect(getResumableRpcSession("old", cursor)).toBe(wrapper);
    expect(wrapper.isReplacementPending()).toBe(true);
    release(); await replacing;
    expect(wrapper.isReplacementPending()).toBe(false);
    expect(getResumableRpcSession("old", cursor)).toBe(wrapper);
  });

  it("keeps at most 64 aliases and expires each after ten minutes without extending on reads", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const { wrapper, cursor, replace } = fixture();
    for (let index = 0; index < 65; index++) await replace();
    expect(getResumableRpcSession("old", cursor)).toBeUndefined();
    expect(getResumableRpcSession("next-1", cursor)).toBe(wrapper);
    vi.setSystemTime(600_999);
    expect(getResumableRpcSession("next-64", cursor)).toBe(wrapper);
    vi.setSystemTime(601_000);
    expect(getResumableRpcSession("next-64", cursor)).toBeUndefined();
    expect(getResumableRpcSession("next-65", cursor)).toBe(wrapper);
  });

  it("does not resume a destroyed epoch even if its wrapper remains in a registry fixture", async () => {
    const { wrapper, cursor, replace } = fixture(); await replace(); wrapper.destroy();
    expect(getResumableRpcSession("old", cursor)).toBeUndefined();
    expect(wrapper.canResumeStream("next-1", cursor)).toBe(false);
  });
});
