import { describe, it, expect, vi } from "vitest";
import { CompactionController } from "../compaction-controller";
import { classifyCompactionError } from "../compaction-state";

describe("Pi compaction transport", () => {
  it("accepts immediately, deduplicates requests and retains the terminal result for reconnect", async () => {
    let finish!: (result: unknown) => void;
    const compact = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const changed = vi.fn();
    const controller = new CompactionController(compact, changed);
    expect(controller.start("one", "keep decisions").status).toBe("running");
    expect(controller.start("one").id).toBe("one");
    expect(controller.start("other-tab").id).toBe("one");
    await Promise.resolve();
    expect(compact).toHaveBeenCalledExactlyOnceWith("keep decisions");
    finish({ summary: "private text", tokensBefore: 42000, estimatedTokensAfter: 12000 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(controller.state).toMatchObject({ id: "one", status: "completed", result: { tokensBefore: 42000, estimatedTokensAfter: 12000 } });
    expect(controller.start("one").status).toBe("completed");
    expect(JSON.stringify(controller.state)).not.toContain("private text");
  });

  it.each(["Already compacted", "Nothing to compact (session too small)"])("treats %s as a no-op, without swallowing provider failures", async (message) => {
    const controller = new CompactionController(vi.fn().mockRejectedValue(new Error(message)), vi.fn());
    controller.start("one");
    await vi.waitFor(() => expect(controller.state?.status).toBe("skipped"));
    expect(classifyCompactionError("400: Nothing to compact (session too small)").status).toBe("failed");
  });

  it("publishes a native completion once even if the command promise later resolves", async () => {
    const changed = vi.fn();
    const controller = new CompactionController(vi.fn().mockResolvedValue({ tokensBefore: 10, estimatedTokensAfter: 5 }), changed);
    controller.start("one");
    controller.observe({ type: "compaction_start", reason: "manual" });
    controller.observe({ type: "compaction_end", result: { tokensBefore: 10, estimatedTokensAfter: 5 }, reason: "manual" });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("tracks automatic compaction, cancellation and failures without inventing success", () => {
    const controller = new CompactionController(vi.fn(), vi.fn());
    controller.observe({ type: "compaction_start", reason: "threshold" });
    controller.observe({ type: "compaction_end", aborted: true });
    expect(controller.state?.status).toBe("cancelled");
    controller.observe({ type: "compaction_start", reason: "overflow" });
    controller.observe({ type: "compaction_end", errorMessage: "Compaction failed: 429 rate limit" });
    expect(controller.state).toMatchObject({ status: "failed", error: "429 rate limit" });
  });
});
