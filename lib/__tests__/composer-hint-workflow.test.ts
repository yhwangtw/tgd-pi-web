import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../rpc-manager", () => ({ getRpcSession: mocks.rpc }));
import { readComposerHintWorkflow } from "../composer-hint-workflow";
const state = { version: 1, goal: { id: "one", objective: "Fix UI", status: "complete", tokens: 1, automaticRuns: 0 }, plan: null };
beforeEach(() => { vi.resetAllMocks(); });
describe("read-only workflow hint lookup", () => {
  it("reads the current SDK branch only, including hidden completed goals", async () => {
    mocks.rpc.mockReturnValue({ isAlive: () => true, inner: { sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-web-workflow-v1", data: state }] } } });
    expect(await readComposerHintWorkflow("one")).toEqual({ goal: { objective: "Fix UI", status: "complete" } });
  });
  it("reads converted historical IDs through the same SDK path", async () => {
    mocks.rpc.mockReturnValue({ isAlive: () => true, inner: { sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-web-workflow-v1", data: state }] } } });
    expect(await readComposerHintWorkflow("dw_one_5")).toEqual({ goal: { objective: "Fix UI", status: "complete" } });
    expect(mocks.rpc).toHaveBeenCalledWith("dw_one_5");
  });
  it("returns unknown for stopped/unavailable engines without starting or resuming them", async () => {
    mocks.rpc.mockReturnValue({ isAlive: () => false });
    expect(await readComposerHintWorkflow("dw_one_5")).toBeNull();
    expect(await readComposerHintWorkflow("missing")).toBeNull();

  });
});
