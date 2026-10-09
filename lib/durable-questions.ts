import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai-durable";
import { defineDoc, defineExtension, defineTool, type Conversation, type ConversationId, type Harness, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { AskUserQuestion, WebExtensionUIClosedEvent, WebExtensionUIDialogRequest, WebExtensionUIEvent, WebExtensionUIResponse, WebExtensionUIResponseResult } from "./web-extension-ui-types";

type Outcome = WebExtensionUIClosedEvent["reason"];
type QuestionRecord = {
  request: string;
  outcome: "pending" | Outcome;
  response: string | null;
  createdAt: number;
  expiresAt: number | null;
  closedAt: number | null;
};
export const DurableQuestions = defineDoc({
  kind: "pi.web.questions", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ namespace: randomUUID(), records: {} as Record<string, QuestionRecord> }),
});

type Draft<T> = T extends unknown ? Omit<T, "id" | "type"> : never;
export type DurableQuestionDraft = Draft<WebExtensionUIDialogRequest>;
export interface DurableQuestionOptions {
  emit?: (event: WebExtensionUIEvent, conversationId?: ConversationId) => void;
}
export interface DurableQuestionWaitOptions extends DurableQuestionOptions {
  /** Stable within the tool invocation when it asks more than one dialog. */
  requestId?: string;
  timeoutMs?: number;
}
export interface DurableHostQuestionOptions extends DurableQuestionWaitOptions {
  signal?: AbortSignal;
}
export interface DurableQuestionAnswer {
  outcome: Outcome;
  response?: WebExtensionUIResponse;
}

const MAX_TEXT = 200_000;
const conversationId = (conversation: Conversation | ConversationId) => typeof conversation === "number" ? conversation : conversation.id;

function emit(options: DurableQuestionOptions, event: WebExtensionUIEvent, id: ConversationId) {
  try { void Promise.resolve(options.emit?.(event, id)).catch(() => {}); } catch { /* durable state survives a disconnected UI */ }
}

function normalize(response: WebExtensionUIResponse): WebExtensionUIResponse | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response) || response.type !== "extension_ui_response"
    || typeof response.id !== "string" || !response.id || response.id.length > 256) return;
  const keys = ["value", "confirmed", "answers", "cancelled"].filter(key => Object.hasOwn(response, key));
  if (keys.length !== 1) return;
  const envelope = { type: "extension_ui_response" as const, id: response.id };
  if ("cancelled" in response) return response.cancelled === true ? { ...envelope, cancelled: true } : undefined;
  if ("confirmed" in response) return typeof response.confirmed === "boolean" ? { ...envelope, confirmed: response.confirmed } : undefined;
  if ("value" in response) return typeof response.value === "string" && response.value.length <= MAX_TEXT ? { ...envelope, value: response.value } : undefined;
  if (!response.answers || typeof response.answers !== "object" || Array.isArray(response.answers)) return;
  const entries = Object.entries(response.answers);
  if (!entries.length || entries.length > 3 || entries.some(([key, value]) => key.length > 64 || typeof value !== "string" || value.length > MAX_TEXT)) return;
  return { ...envelope, answers: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) };
}

function valid(request: WebExtensionUIDialogRequest, response: WebExtensionUIResponse) {
  if ("cancelled" in response) return true;
  if (request.method === "confirm") return "confirmed" in response;
  if (request.method === "select") return "value" in response && request.options.includes(response.value);
  if (request.method === "input" || request.method === "editor") return "value" in response;
  if (!("answers" in response)) return false;
  const ids = new Set(request.questions.map(question => question.id));
  return Object.keys(response.answers).length === ids.size && Object.keys(response.answers).every(id => ids.has(id))
    && request.questions.every(question => {
      const answer = response.answers[question.id];
      return typeof answer === "string" && answer.trim().length > 0
        && (question.allowOther || question.options.some(option => option.label === answer));
    });
}

function answer(record: QuestionRecord): DurableQuestionAnswer {
  if (record.outcome === "pending") throw new Error("Question has not been answered");
  return { outcome: record.outcome, ...(record.response === null ? {} : { response: JSON.parse(record.response) as WebExtensionUIResponse }) };
}

/** Read-only: never starts/resumes model execution or returns private receipts. */
export async function durableQuestionSnapshot(harness: Harness, conversation: Conversation | ConversationId, context: Context = BACKGROUND_CONTEXT): Promise<WebExtensionUIDialogRequest[]> {
  const state = await harness.snapshot(DurableQuestions, conversationId(conversation), context);
  return Object.values(state?.records ?? {}).filter(record => record.outcome === "pending" && (record.expiresAt === null || record.expiresAt > Date.now()))
    .map(record => {
      const request = JSON.parse(record.request) as WebExtensionUIDialogRequest;
      return record.expiresAt !== null && "timeout" in request ? { ...request, timeout: Math.max(0, record.expiresAt - Date.now()) } : request;
    });
}

/** Commit before acknowledgement: lost HTTP replies can safely retry the same answer. */
export async function respondDurableQuestion(harness: Harness, conversation: Conversation | ConversationId, response: WebExtensionUIResponse,
  options: DurableQuestionOptions = {}, context: Context = BACKGROUND_CONTEXT): Promise<WebExtensionUIResponseResult> {
  const normalized = normalize(response);
  if (!normalized) return { accepted: false, reason: "invalid_response" };
  const id = conversationId(conversation);
  let closed: Outcome | undefined;
  const result = await harness.commit(async tx => {
    const doc = await tx.doc(DurableQuestions, id);
    const record = doc.records[normalized.id];
    if (!record) return { accepted: false, reason: "not_found" } as const;
    if (record.outcome === "pending" && record.expiresAt !== null && record.expiresAt <= Date.now()) {
      record.outcome = "timeout"; record.closedAt = Date.now(); closed = "timeout";
    }
    const encoded = JSON.stringify(normalized);
    if (record.outcome !== "pending") {
      if (record.response === encoded) return { accepted: true, receipt: record.outcome === "cancelled" ? "already_cancelled" : "already_answered" } as const;
      const reason = record.outcome === "answered" ? "response_conflict" : record.outcome === "cancelled" ? "cancelled" : record.outcome === "timeout" ? "expired" : "closed";
      return { accepted: false, reason } as const;
    }
    if (!valid(JSON.parse(record.request) as WebExtensionUIDialogRequest, normalized)) return { accepted: false, reason: "invalid_response" } as const;
    record.response = encoded;
    record.outcome = "cancelled" in normalized ? "cancelled" : "answered";
    record.closedAt = Date.now();
    closed = record.outcome;
    return { accepted: true } as const;
  }, context);
  if (closed) emit(options, { type: "extension_ui_closed", id: normalized.id, reason: closed }, id);
  return result;
}

/** Explicit user/runtime cancellation; ordinary Harness.close must not call this. */
export async function cancelDurableQuestions(harness: Harness, conversation: Conversation | ConversationId, reason: Exclude<Outcome, "answered"> = "aborted",
  options: DurableQuestionOptions = {}, context: Context = BACKGROUND_CONTEXT): Promise<void> {
  const ids = await harness.commit(async tx => {
    const doc = await tx.doc(DurableQuestions, conversationId(conversation));
    const changed: string[] = [];
    for (const [id, record] of Object.entries(doc.records)) if (record.outcome === "pending") {
      record.outcome = reason; record.closedAt = Date.now(); changed.push(id);
    }
    return changed;
  }, context);
  for (const id of ids) emit(options, { type: "extension_ui_closed", id, reason }, conversationId(conversation));
}

/** Durable select/confirm/input/editor/ask_user primitive for native extensions.
 * Waiting invocations are replay-safe because both the question and its answer
 * live in the conversation, under a stable task/request identity. */
type QuestionOperations = Pick<ToolExecutionApi, "commit" | "snapshot" | "watchDoc" | "conversationId">;

export function waitForDurableQuestion(api: ToolExecutionApi, draft: DurableQuestionDraft, context: Context,
  options: DurableQuestionWaitOptions = {}): Promise<DurableQuestionAnswer> {
  return waitForQuestion(api, `task:${api.taskId}`, draft, context, options);
}

/** Host commands must reuse requestId after reconnect/restart to retrieve the
 * same question/receipt. Aborting this waiter does not erase the saved question. */
export function waitForDurableHostQuestion(harness: Harness, conversation: Conversation | ConversationId, draft: DurableQuestionDraft,
  options: DurableHostQuestionOptions = {}, context: Context = BACKGROUND_CONTEXT): Promise<DurableQuestionAnswer> {
  const requestId = options.requestId ?? randomUUID();
  return waitForQuestion({
    conversationId: conversationId(conversation), commit: harness.commit.bind(harness),
    snapshot: harness.snapshot.bind(harness), watchDoc: harness.watchDoc.bind(harness),
  }, "host", draft, options.signal ? withAbortSignal(options.signal, context) : context, { ...options, requestId });
}

async function waitForQuestion(api: QuestionOperations, owner: string, draft: DurableQuestionDraft, context: Context,
  options: DurableQuestionWaitOptions): Promise<DurableQuestionAnswer> {
  const timeoutMs = options.timeoutMs ?? ("timeout" in draft ? draft.timeout : undefined);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) throw new Error("Invalid question timeout");
  const request = await api.commit(async tx => {
    const doc = await tx.doc(DurableQuestions, api.conversationId);
    // Numeric conversation/task IDs repeat in independent SQLite stores. Keep a
    // persisted namespace so browser IDs cannot collide across those sessions.
    const id = `question-${createHash("sha256").update(JSON.stringify([doc.namespace, api.conversationId, owner, options.requestId ?? draft.method])).digest("hex")}`;
    const request = { ...draft, type: "extension_ui_request", id } as WebExtensionUIDialogRequest;
    const encoded = JSON.stringify(request);
    const existing = doc.records[id];
    if (existing && existing.request !== encoded) throw new Error("Question request conflicts with its saved identity");
    if (!existing) doc.records[id] = { request: encoded, outcome: "pending", response: null, createdAt: Date.now(),
      expiresAt: timeoutMs ? Date.now() + timeoutMs : null, closedAt: null };
    return request;
  }, context);
  const id = request.id;
  const expire = async () => {
    let changed = false;
    await api.commit(async tx => {
      const record = (await tx.doc(DurableQuestions, api.conversationId)).records[id];
      if (record.outcome === "pending" && record.expiresAt !== null && record.expiresAt <= Date.now()) {
        record.outcome = "timeout"; record.closedAt = Date.now(); changed = true;
      }
    }, context);
    if (changed) emit(options, { type: "extension_ui_closed", id, reason: "timeout" }, api.conversationId);
  };
  await expire();
  const saved = (await api.snapshot(DurableQuestions, api.conversationId, context))!.records[id];
  if (saved.outcome !== "pending") return answer(saved);
  emit(options, request, api.conversationId);
  const watch = await api.watchDoc(DurableQuestions, api.conversationId, context);
  if (!watch) throw new Error("Durable question document is missing");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<DurableQuestionAnswer>((resolve, reject) => {
      abort = () => reject(new Error("Question invocation interrupted"));
      if (context.abortSignal?.aborted) { abort(); return; }
      context.abortSignal?.addEventListener("abort", abort, { once: true });
      const accept = (state: typeof watch.value) => {
        const record = state?.records[id];
        if (record && record.outcome !== "pending") resolve(answer(record));
      };
      watch.start(async state => accept(state));
      accept(watch.value);
      if (saved.expiresAt !== null) timer = setTimeout(() => { void expire().catch(reject); }, Math.max(0, saved.expiresAt - Date.now()));
      void watch.closed.then(result => { if (result.reason !== "stopped") reject(new Error("Question observer was closed")); });
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) context.abortSignal?.removeEventListener("abort", abort);
    await watch.stop();
  }
}

const QuestionSchema = Type.Object({
  id: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }),
  header: Type.Optional(Type.String({ maxLength: 40 })),
  question: Type.String({ minLength: 1, maxLength: 2_000 }),
  options: Type.Optional(Type.Array(Type.Object({ label: Type.String({ minLength: 1, maxLength: 200 }), description: Type.Optional(Type.String({ maxLength: 500 })) }), { maxItems: 6 })),
  allowOther: Type.Optional(Type.Boolean()),
});

export function createDurableQuestionsExtension(options: DurableQuestionOptions = {}) {
  return defineExtension({ name: "pi-web-questions", tools: [defineTool({
    name: "ask_user", description: "Pause and ask the user one to three focused questions when their decision is required to continue.",
    parameters: Type.Object({ questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 3 }) }),
    replay: "safe", executionMode: "sequential",
    execute: async (args, api, context) => {
      if (new Set(args.questions.map(question => question.id)).size !== args.questions.length) throw new Error("ask_user question ids must be unique");
      const questions: AskUserQuestion[] = args.questions.map(question => {
        const choices = question.options ?? [];
        if (new Set(choices.map(choice => choice.label)).size !== choices.length) throw new Error("ask_user option labels must be unique");
        return { ...question, options: choices, allowOther: choices.length === 0 || question.allowOther === true };
      });
      const result = await waitForDurableQuestion(api, { method: "ask_user", questions }, context, options);
      const answers = result.response && "answers" in result.response ? result.response.answers : undefined;
      return answers ? { content: [{ type: "text", text: `User answers: ${JSON.stringify(answers)}` }], details: { cancelled: false, answers, outcome: result.outcome } }
        : { content: [{ type: "text", text: result.outcome === "timeout" ? "The question timed out." : "The user cancelled the question." }], details: { cancelled: true, answers: {}, outcome: result.outcome } };
    },
  })] });
}
