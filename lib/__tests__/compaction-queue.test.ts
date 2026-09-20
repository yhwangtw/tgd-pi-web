import { describe, expect, it, vi } from "vitest";
import { AgentSessionWrapper } from "../rpc-manager";
import type { AgentSessionLike } from "../pi-types";

function setup() {
  let finish!: (result: unknown) => void;
  const inner = {
    sessionId: "compact-test", sessionFile: "", isStreaming: false, isCompacting: false,
    compact: vi.fn(() => new Promise(resolve => { finish = resolve; })),
    prompt: vi.fn().mockResolvedValue(undefined), followUp: vi.fn().mockResolvedValue(undefined), steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(), subscribe: vi.fn(() => vi.fn()),
  };
  const wrapper = new AgentSessionWrapper(inner as unknown as AgentSessionLike);
  return { inner, wrapper, finish: () => finish({ tokensBefore: 30000, estimatedTokensAfter: 9000 }) };
}
describe("background compaction queue", () => {
  it("accepts before summary completes, protects its runtime, and submits text/images once", async () => {
    const { inner, wrapper, finish } = setup();
    try {
      const accepted = await wrapper.send({ type: "compact", background: true, requestId: "one" });
      expect(accepted).toMatchObject({ status: "running" });
      expect(wrapper.requestAuthRefresh()).toBe("deferred");
      await wrapper.send({ type: "compact", background: true, requestId: "one" });
      expect(inner.compact).toHaveBeenCalledOnce();
      const command = { type: "queue_compaction_prompt", id: "q1", message: "continue", images: [{ data: "abc", mimeType: "image/png" }] };
      await wrapper.send(command); await wrapper.send(command);
      expect(inner.prompt).not.toHaveBeenCalled();
      expect(await wrapper.send({ type: "get_state" })).toMatchObject({ compactionQueue: [{ id: "q1" }] });
      finish();
      await vi.waitFor(() => expect(inner.prompt).toHaveBeenCalledExactlyOnceWith("continue", { images: [{ type: "image", data: "abc", mimeType: "image/png" }] }));
      await wrapper.send(command);
      expect(inner.prompt).toHaveBeenCalledOnce();
      expect(await wrapper.send({ type: "get_state" })).toMatchObject({ compaction: { status: "completed" }, compactionQueue: [] });
    } finally { wrapper.destroy(); }
  });

  it("clears pending messages without sending them", async () => {
    const { inner, wrapper, finish } = setup();
    try {
      await wrapper.send({ type: "compact", background: true, requestId: "one" });
      await wrapper.send({ type: "queue_compaction_prompt", id: "q1", message: "discard" });
      await wrapper.send({ type: "clear_compaction_queue" }); finish();
      await vi.waitFor(async () => expect(await wrapper.send({ type: "get_state" })).toMatchObject({ compaction: { status: "completed" } }));
      expect(inner.prompt).not.toHaveBeenCalled();
    } finally { wrapper.destroy(); }
  });

  it("flushes on Pi no-op and retains setup failures for an explicit queue retry", async () => {
    const { inner, wrapper } = setup();
    let reject!: (error: Error) => void;
    inner.compact.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    inner.prompt.mockRejectedValueOnce(new Error("No model configured"));
    try {
      await wrapper.send({ type: "compact", background: true, requestId: "one" });
      await wrapper.send({ type: "queue_compaction_prompt", id: "q1", message: "continue" });
      reject(new Error("Already compacted"));
      await vi.waitFor(() => expect(inner.prompt).toHaveBeenCalledOnce());
      expect(await wrapper.send({ type: "get_state" })).toMatchObject({ compaction: { status: "skipped" }, compactionQueue: [{ message: "continue" }] });
      await wrapper.send({ type: "retry_compaction_queue" });
      await vi.waitFor(() => expect(inner.prompt).toHaveBeenCalledTimes(2));
      expect(inner.compact).toHaveBeenCalledOnce();
    } finally { wrapper.destroy(); }
  });
});
