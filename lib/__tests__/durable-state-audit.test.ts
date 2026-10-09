import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai-durable";
import { createRegistry, defineDoc, defineExtension, defineTool, GenerationTask, Harness, hook, type HarnessOptions } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// Pre-integration experiments exercise the real upstream runtime. They do not
// claim that Pi Web's existing workflow or question UI already uses these APIs.
const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const harnesses = new Set<Harness>();

async function fixture(registry = createRegistry()) {
  const directory = mkdtempSync(join(tmpdir(), "durable-state-audit-"));
  directories.push(directory);
  const faux = fauxProvider({ provider: "state-audit", models: [{ id: "model" }], tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  async function open() {
    const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "state.sqlite")), {
      registry, models: models as unknown as HarnessOptions["models"], settings: { retry: { enabled: false }, compaction: { enabled: false } },
    }, context);
    harnesses.add(harness);
    const root = await harness.root(context, { agent: { model: { provider: "state-audit", modelId: "model" } } });
    return { harness, root };
  }
  return { faux, registry, open, ...await open() };
}

async function close(harness: Harness) {
  await harness.close(context);
  harnesses.delete(harness);
}

afterEach(async () => {
  for (const harness of harnesses) await close(harness);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Durable persistent state feasibility (not product integration)", () => {
  it("retains a pending question through reopen and commits one consistent answer receipt", async () => {
    const Question = defineDoc({ kind: "audit.question", version: 1, scope: "conversation", history: "latest", fork: "initial",
      initial: () => ({ id: "", status: "empty", answer: "" }),
    });
    const f = await fixture();
    let deliveries = 0;
    f.registry.install(defineExtension({ name: "question-probe", tools: [defineTool({
      name: "ask", description: "Ask the user", parameters: Type.Object({}), replay: "safe",
      execute: async (_args, api, ctx) => {
        await api.commit(async tx => {
          const doc = await tx.doc(Question, api.conversationId);
          if (doc.status === "empty") { doc.id = api.callId; doc.status = "pending"; deliveries++; }
        }, ctx);
        const saved = await api.snapshot(Question, api.conversationId, ctx);
        if (saved?.status === "answered") return { content: [{ type: "text", text: saved.answer }] };
        const watch = await api.watchDoc(Question, api.conversationId, ctx);
        if (!watch) throw new Error("Question document missing");
        try {
          const answer = await new Promise<string>((resolve, reject) => {
            const aborted = () => reject(new Error("Question invocation interrupted"));
            if (ctx.abortSignal?.aborted) return aborted();
            ctx.abortSignal?.addEventListener("abort", aborted, { once: true });
            const accept = (value: typeof saved) => {
              if (value?.status === "answered") {
                ctx.abortSignal?.removeEventListener("abort", aborted);
                resolve(value.answer);
              }
            };
            watch.start(async value => accept(value ?? undefined));
            accept(watch.value ?? undefined);
          });
          return { content: [{ type: "text", text: answer }] };
        } finally { await watch.stop(); }
      },
    })] }));
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask", {}), { stopReason: "toolUse" }),
      transcript => {
        const result = transcript.messages.findLast(message => message.role === "toolResult" && message.toolName === "ask");
        expect(result).toMatchObject({ role: "toolResult", content: [{ type: "text", text: "Staging" }] });
        expect(result).not.toMatchObject({ isError: true });
        return fauxAssistantMessage("Recorded the user's answer");
      },
    ]);
    const request = { type: "input", content: "Ask once", requestId: "question-request" } as const;
    await f.root.submit(request, context);
    await vi.waitFor(async () => expect((await f.harness.snapshot(Question, f.root.id, context))?.status).toBe("pending"));
    const pending = await f.harness.snapshot(Question, f.root.id, context);
    await close(f.harness);
    const reopened = await f.open();
    expect(await reopened.harness.snapshot(Question, reopened.root.id, context)).toEqual(pending);
    expect((await reopened.harness.inspect(context)).scheduling).toBe("paused");
    const answer = (value: string) => reopened.root.commit(async tx => {
      const doc = await tx.doc(Question, reopened.root.id);
      if (doc.status === "answered") {
        if (doc.answer !== value) throw new Error("Answer conflicts with saved receipt");
        return false;
      }
      doc.status = "answered";
      doc.answer = value;
      return true;
    }, context);
    expect(await answer("Staging")).toBe(true);
    expect(await answer("Staging")).toBe(false);
    await expect(answer("Production")).rejects.toThrow("conflicts");
    expect((await (await reopened.root.submit(request, context)).wait(context)).status).toBe("done");
    expect(deliveries).toBe(1);
    expect(f.faux.state.callCount).toBe(2);
    const entries = await reopened.root.entries({}, 100, undefined, context);
    expect(entries.items.flatMap(entry => entry.model ?? []).find(message => message.role === "assistant")).toMatchObject({
      content: [{ type: "text", text: "Recorded the user's answer" }],
    });
  });

  it("persists plan and goal state and stops continuation when the completion tool commits", async () => {
    const Workflow = defineDoc({ kind: "audit.workflow", version: 1, scope: "conversation", history: "latest", fork: "current",
      initial: () => ({ goal: "active", steps: [] as string[] }),
    });
    const f = await fixture();
    await f.root.commit(async tx => { await tx.doc(Workflow, f.root.id); }, context);
    f.registry.install(defineExtension({ name: "workflow-probe", tools: [defineTool({
      name: "complete_plan", description: "Save verified completion", parameters: Type.Object({ evidence: Type.String() }),
      execute: async (args, api, ctx) => {
        await api.commit(async tx => {
          const doc = await tx.doc(Workflow, api.conversationId);
          doc.steps = [args.evidence];
          doc.goal = "complete";
        }, ctx);
        return { content: [{ type: "text", text: "Plan complete" }], details: { evidence: args.evidence } };
      },
    })], hooks: [hook(GenerationTask, { onYield: async (_answer, api, ctx) => {
      const state = await api.snapshot(Workflow, api.conversationId, ctx);
      return state?.goal === "active" ? { continue: "Continue toward the saved goal" } : undefined;
    } })] }));
    f.faux.setResponses([
      fauxAssistantMessage("First inspection completed"),
      fauxAssistantMessage(fauxToolCall("complete_plan", { evidence: "Verified fixture" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("All requested steps verified"),
    ]);
    expect((await (await f.root.submit({ type: "input", content: "Finish this goal" }, context)).wait(context)).status).toBe("done");
    expect(f.faux.state.callCount).toBe(3);
    await close(f.harness);
    const reopened = await f.open();
    expect(await reopened.harness.snapshot(Workflow, reopened.root.id, context)).toEqual({ goal: "complete", steps: ["Verified fixture"] });
    expect((await reopened.harness.inspect(context)).tasks).toHaveLength(0);
  });

  it("reuses a persisted context-hook memo when an interrupted model request resumes", async () => {
    const f = await fixture();
    const recall = vi.fn(async () => "Remember the accepted fixture constraint");
    f.registry.install(defineExtension({ name: "memory-probe", hooks: [hook(GenerationTask, {
      beforeRequest: async (request, api, ctx) => {
        let memory = await api.memo<string>("recalled-memory", ctx);
        if (memory === undefined) memory = await api.memo("recalled-memory", await recall(), ctx);
        return { messages: [...request.messages, { role: "user", content: memory, timestamp: 0 }] };
      },
    })] }));
    f.faux.setResponses([(_transcript, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
    })]);
    const request = { type: "input", content: "Use the saved constraints", requestId: "memory-request" } as const;
    await f.root.submit(request, context);
    await vi.waitFor(() => expect(f.faux.state.callCount).toBe(1));
    await close(f.harness);
    f.faux.setResponses([transcript => {
      expect(transcript.messages.at(-1)).toMatchObject({ content: "Remember the accepted fixture constraint" });
      return fauxAssistantMessage("Recovered with the same memory context");
    }]);
    const reopened = await f.open();
    expect((await (await reopened.root.submit(request, context)).wait(context)).status).toBe("done");
    expect(recall).toHaveBeenCalledOnce();
    const entries = await reopened.root.entries({}, 100, undefined, context);
    expect(entries.items.flatMap(entry => entry.model ?? []).filter(message => message.role === "user")).toHaveLength(1);
  });
});
