import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), durable: vi.fn(), snapshot: vi.fn() }));
vi.mock("../rpc-manager", () => ({ getRpcSession: mocks.rpc }));
vi.mock("../durable-chat", () => ({ getDurableChat: mocks.durable }));
vi.mock("../durable-workflow", () => ({ readDurableWorkflow: mocks.snapshot }));
import { readComposerHintWorkflow } from "../composer-hint-workflow";
const state = { version: 1, goal: { id: "one", objective: "Fix UI", status: "complete", tokens: 1, automaticRuns: 0 }, plan: null };
beforeEach(() => { vi.resetAllMocks(); });
describe("read-only workflow hint lookup", () => {
  it("reads the current SDK branch only, including hidden completed goals", async () => {
    mocks.rpc.mockReturnValue({ isAlive: () => true, inner: { sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-web-workflow-v1", data: state }] } } });
    expect(await readComposerHintWorkflow("one")).toEqual({ goal: { objective: "Fix UI", status: "complete" } });
  });
  it("reads the already-open Durable document without executing a command", async () => {
    const chat = { isAlive: () => true, harness: {}, conversation: { id: 5 } };
    mocks.durable.mockReturnValue(chat); mocks.snapshot.mockResolvedValue(state);
    expect(await readComposerHintWorkflow("dw_one_5")).toEqual({ goal: { objective: "Fix UI", status: "complete" } });
    expect(mocks.snapshot).toHaveBeenCalledWith(chat.harness, 5);
  });
  it("returns unknown for stopped/unavailable engines without starting or resuming them", async () => {
    mocks.durable.mockReturnValue({ isAlive: () => false });
    expect(await readComposerHintWorkflow("dw_one_5")).toBeNull();
    expect(await readComposerHintWorkflow("missing")).toBeNull();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});
