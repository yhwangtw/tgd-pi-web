import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai-durable";
import { createRegistry, defineExtension, defineTool, Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { cancelDurableQuestions, createDurableQuestionsExtension, DurableQuestions, durableQuestionSnapshot, respondDurableQuestion, waitForDurableHostQuestion, waitForDurableQuestion, type DurableQuestionDraft } from "../durable-questions";
import type { WebExtensionUIEvent, WebExtensionUIResponse } from "../web-extension-ui-types";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const opened = new Set<Harness>();
async function close(harness: Harness) { await harness.close(context); opened.delete(harness); }
afterEach(async () => {
  for (const harness of [...opened]) await close(harness);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(draft?: DurableQuestionDraft, timeoutMs?: number) {
  const directory = mkdtempSync(join(tmpdir(), "pi-durable-questions-")); directories.push(directory);
  const events: WebExtensionUIEvent[] = [];
  const options = { emit: (event: WebExtensionUIEvent) => { events.push(event); } };
  const registry = createRegistry();
  registry.install(createDurableQuestionsExtension(options));
  if (draft) registry.install(defineExtension({ name: "dialog-test", tools: [defineTool({
    name: "dialog", description: "Ask through an extension", parameters: Type.Object({}), replay: "safe",
    async execute(_args, api, ctx) {
      const result = await waitForDurableQuestion(api, draft, ctx, { ...options, timeoutMs });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  })] }));
  const faux = fauxProvider({ provider: "questions-test", models: [{ id: "model" }], tokensPerSecond: 0 });
  const models = createModels(); models.setProvider(faux.provider);
  async function open() {
    const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "state.sqlite")), {
      registry, models: models as unknown as HarnessOptions["models"], settings: { retry: { enabled: false }, compaction: { enabled: false } },
    }, context);
    opened.add(harness);
    const root = await harness.root(context, { agent: { model: { provider: "questions-test", modelId: "model" } } });
    return { harness, root };
  }
  return { open, faux, events, options };
}

const ask = () => fauxAssistantMessage(fauxToolCall("ask_user", { questions: [
  { id: "target", question: "Where?", options: [{ label: "Staging" }, { label: "Production" }] },
  { id: "note", question: "Release note?", allowOther: false },
] }), { stopReason: "toolUse" });

describe("durable Web questions", () => {
  it("keeps question IDs distinct across independent stores with the same numeric conversation and request IDs", async () => {
    const a = await fixture().open(); const b = await fixture().open();
    const draft = { method: "confirm", title: "Continue", message: "Continue?" } as const;
    const first = waitForDurableHostQuestion(a.harness, a.root, draft, { requestId: "same-id" });
    const second = waitForDurableHostQuestion(b.harness, b.root, draft, { requestId: "same-id" });
    await vi.waitFor(async () => expect(await durableQuestionSnapshot(a.harness, a.root)).toHaveLength(1));
    await vi.waitFor(async () => expect(await durableQuestionSnapshot(b.harness, b.root)).toHaveLength(1));
    const left = (await durableQuestionSnapshot(a.harness, a.root))[0]; const right = (await durableQuestionSnapshot(b.harness, b.root))[0];
    expect(left.id).not.toBe(right.id);
    await respondDurableQuestion(a.harness, a.root, { type: "extension_ui_response", id: left.id, confirmed: true });
    await respondDurableQuestion(b.harness, b.root, { type: "extension_ui_response", id: right.id, confirmed: false });
    expect(await first).toMatchObject({ response: { confirmed: true } });
    expect(await second).toMatchObject({ response: { confirmed: false } });
  });

  it("restores a host-command question by stable requestId without creating a model task", async () => {
    const f = fixture();
    const first = await f.open();
    const draft = { method: "input", title: "Goal objective" } as const;
    const options = { ...f.options, requestId: "goal-command-1" };
    const waiting = waitForDurableHostQuestion(first.harness, first.root, draft, options);
    const interrupted = expect(waiting).rejects.toThrow(/closed/i);
    await vi.waitFor(async () => expect(await durableQuestionSnapshot(first.harness, first.root)).toHaveLength(1));
    const original = (await durableQuestionSnapshot(first.harness, first.root))[0];
    await close(first.harness); await interrupted;
    const second = await f.open();
    const restored = waitForDurableHostQuestion(second.harness, second.root, draft, options);
    await vi.waitFor(async () => expect(await durableQuestionSnapshot(second.harness, second.root)).toEqual([original]));
    expect(await respondDurableQuestion(second.harness, second.root, { type: "extension_ui_response", id: original.id, value: "Verify the release" })).toEqual({ accepted: true });
    expect(await restored).toMatchObject({ outcome: "answered", response: { value: "Verify the release" } });
    expect(await waitForDurableHostQuestion(second.harness, second.root, draft, options)).toMatchObject({ outcome: "answered", response: { value: "Verify the release" } });
    await expect(waitForDurableHostQuestion(second.harness, second.root, { method: "input", title: "Different question" }, options)).rejects.toThrow("conflicts");
    expect(f.faux.state.callCount).toBe(0);
  });

  it("restores the same pending ask_user and returns a committed answer to the model once across lost ACK and reopen", async () => {
    const f = fixture();
    f.faux.setResponses([ask(), transcript => {
      const result = transcript.messages.find(message => message.role === "toolResult" && message.toolName === "ask_user");
      expect(result).not.toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain('User answers: {\\"note\\":\\"Verified\\",\\"target\\":\\"Staging\\"}');
      return fauxAssistantMessage("The persisted answers arrived");
    }]);
    const first = await f.open();
    const input = { type: "input", content: "Ask the user", requestId: "ask-once" } as const;
    await first.root.submit(input, context);
    await vi.waitFor(async () => expect(await durableQuestionSnapshot(first.harness, first.root)).toHaveLength(1));
    const question = (await durableQuestionSnapshot(first.harness, first.root))[0];
    expect(question).toMatchObject({ method: "ask_user", questions: [{ id: "target", allowOther: false }, { id: "note", allowOther: true }] });
    await close(first.harness);
    const second = await f.open();
    expect(await durableQuestionSnapshot(second.harness, second.root.id)).toEqual([question]);
    expect(f.faux.state.callCount).toBe(1); // Reading pending UI cannot resume a model.
    expect(await respondDurableQuestion(second.harness, second.root, { type: "extension_ui_response", id: question.id, value: "wrong-kind" })).toEqual({ accepted: false, reason: "invalid_response" });
    const response = { type: "extension_ui_response", id: question.id, answers: { target: "Staging", note: "Verified" } } as const;
    const receipts = await Promise.all([
      respondDurableQuestion(second.harness, second.root, response, f.options),
      respondDurableQuestion(second.harness, second.root, { ...response, answers: { note: "Verified", target: "Staging" } }, f.options),
    ]);
    expect(receipts).toEqual([{ accepted: true }, { accepted: true, receipt: "already_answered" }]);
    expect(await respondDurableQuestion(second.harness, second.root, { ...response, answers: { note: "Verified", target: "Production" } })).toEqual({ accepted: false, reason: "response_conflict" });
    expect((await (await second.root.submit(input, context)).wait(context)).status).toBe("done");
    expect(JSON.stringify((await second.root.context(context)).messages)).toContain("The persisted answers arrived");
    expect(f.faux.state.callCount).toBe(2);
    expect(await durableQuestionSnapshot(second.harness, second.root)).toEqual([]);
    expect(f.events.filter(event => event.type === "extension_ui_closed" && event.reason === "answered")).toHaveLength(1);
    await close(second.harness);
    const third = await f.open();
    expect(await respondDurableQuestion(third.harness, third.root, response)).toEqual({ accepted: true, receipt: "already_answered" });
  });

  it("persists cancellation receipts and returns cancellation rather than inventing an answer", async () => {
    const f = fixture();
    f.faux.setResponses([ask(), transcript => {
      expect(JSON.stringify(transcript.messages.filter(message => message.role === "toolResult"))).toContain("The user cancelled the question.");
      return fauxAssistantMessage("Cancellation observed");
    }]);
    const first = await f.open();
    const submission = await first.root.submit({ type: "input", content: "Ask", requestId: "cancel" }, context);
    await vi.waitFor(async () => expect(await durableQuestionSnapshot(first.harness, first.root)).toHaveLength(1));
    const id = (await durableQuestionSnapshot(first.harness, first.root))[0].id;
    const response = { type: "extension_ui_response", id, cancelled: true } as const;
    expect(await respondDurableQuestion(first.harness, first.root, response, f.options)).toEqual({ accepted: true });
    expect((await submission.wait(context)).status).toBe("done");
    await close(first.harness);
    const second = await f.open();
    expect(await respondDurableQuestion(second.harness, second.root, response)).toEqual({ accepted: true, receipt: "already_cancelled" });
    expect(await respondDurableQuestion(second.harness, second.root, { type: "extension_ui_response", id, answers: { target: "Staging", note: "Later" } })).toEqual({ accepted: false, reason: "cancelled" });
  });

  it("explicit runtime abort closes pending questions without resuming a model after reopen", async () => {
    const f = fixture(); f.faux.setResponses([ask()]);
    const first = await f.open();
    const input = { type: "input", content: "Ask", requestId: "abort" } as const;
    await first.root.submit(input, context);
    await vi.waitFor(async () => expect(await durableQuestionSnapshot(first.harness, first.root)).toHaveLength(1));
    const id = (await durableQuestionSnapshot(first.harness, first.root))[0].id;
    await first.root.abort(context);
    await cancelDurableQuestions(first.harness, first.root, "aborted", f.options);
    await close(first.harness);
    const second = await f.open();
    expect(await durableQuestionSnapshot(second.harness, second.root)).toEqual([]);
    expect((await (await second.root.submit(input, context)).wait(context)).status).toBe("unanswered");
    expect(f.faux.state.callCount).toBe(1);
    expect(await respondDurableQuestion(second.harness, second.root, { type: "extension_ui_response", id, cancelled: true })).toEqual({ accepted: false, reason: "closed" });
  });

  it.each([
    { draft: { method: "select", title: "Target", options: ["Staging"] }, accepted: { value: "Staging" }, invalid: { value: "Missing" } },
    { draft: { method: "confirm", title: "Confirm", message: "Continue?" }, accepted: { confirmed: false }, invalid: { value: "yes" } },
    { draft: { method: "input", title: "Name", placeholder: "Name" }, accepted: { value: "" }, invalid: { confirmed: true } },
    { draft: { method: "editor", title: "Notes", prefill: "Initial" }, accepted: { value: "Edited notes" }, invalid: { confirmed: true } },
  ] as const)("supports extension $draft.method dialogs with the existing UI envelopes", async ({ draft, accepted, invalid }) => {
    const f = fixture({ ...draft, ...("options" in draft ? { options: [...(draft.options ?? [])] } : {}) } as DurableQuestionDraft);
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("dialog", {}), { stopReason: "toolUse" }), transcript => {
      const result = transcript.messages.find(message => message.role === "toolResult");
      expect(result).not.toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("answered");
      return fauxAssistantMessage("Extension answer accepted");
    }]);
    const { harness, root } = await f.open();
    const submission = await root.submit({ type: "input", content: "Ask extension" }, context);
    await vi.waitFor(async () => expect(await durableQuestionSnapshot(harness, root)).toHaveLength(1));
    const question = (await durableQuestionSnapshot(harness, root))[0];
    expect(question).toMatchObject({ type: "extension_ui_request", method: draft.method, title: draft.title });
    expect(await respondDurableQuestion(harness, root, { type: "extension_ui_response", id: question.id, ...invalid } as WebExtensionUIResponse)).toEqual({ accepted: false, reason: "invalid_response" });
    expect(await respondDurableQuestion(harness, root, { type: "extension_ui_response", id: question.id, ...accepted } as WebExtensionUIResponse)).toEqual({ accepted: true });
    expect((await submission.wait(context)).status).toBe("done");
  });

  it("keeps the original deadline across close and persists an expired receipt before rejecting a late answer", async () => {
    const f = fixture({ method: "select", title: "Expiring", options: ["Yes"] }, 180);
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("dialog", {}), { stopReason: "toolUse" }), transcript => {
      expect(JSON.stringify(transcript.messages.filter(message => message.role === "toolResult"))).toContain("timeout");
      return fauxAssistantMessage("Timeout observed");
    }]);
    const first = await f.open();
    const input = { type: "input", content: "Time out", requestId: "timeout" } as const;
    await first.root.submit(input, context);
    await vi.waitFor(async () => expect(await durableQuestionSnapshot(first.harness, first.root)).toHaveLength(1));
    const id = (await durableQuestionSnapshot(first.harness, first.root))[0].id;
    const deadline = (await first.harness.snapshot(DurableQuestions, first.root.id, context))!.records[id].expiresAt;
    await close(first.harness);
    await new Promise(resolve => setTimeout(resolve, 220));
    const second = await f.open();
    expect(await durableQuestionSnapshot(second.harness, second.root)).toEqual([]);
    expect(await respondDurableQuestion(second.harness, second.root, { type: "extension_ui_response", id, value: "Yes" })).toEqual({ accepted: false, reason: "expired" });
    expect((await second.harness.snapshot(DurableQuestions, second.root.id, context))!.records[id]).toMatchObject({ outcome: "timeout", expiresAt: deadline });
    expect((await (await second.root.submit(input, context)).wait(context)).status).toBe("done");
  });

  it("expires an actively waiting dialog without a browser response", async () => {
    const f = fixture({ method: "input", title: "Expiring" }, 50);
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("dialog", {}), { stopReason: "toolUse" }), transcript => {
      expect(JSON.stringify(transcript.messages.filter(message => message.role === "toolResult"))).toContain("timeout");
      return fauxAssistantMessage("Timeout observed");
    }]);
    const { harness, root } = await f.open();
    expect((await (await root.submit({ type: "input", content: "Wait" }, context)).wait(context)).status).toBe("done");
    expect(await durableQuestionSnapshot(harness, root)).toEqual([]);
    expect(f.events).toContainEqual(expect.objectContaining({ type: "extension_ui_closed", reason: "timeout" }));
  });
});
