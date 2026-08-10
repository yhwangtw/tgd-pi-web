import { randomUUID } from "node:crypto";
import {
  defineTool,
  type ExtensionUIDialogOptions,
  type ExtensionUIContext,
  type ExtensionWidgetOptions,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  AskUserQuestion,
  WebExtensionUIDecisionRecord,
  WebExtensionUIDialogRequest,
  WebExtensionUIEvent,
  WebExtensionUIRequest,
  WebExtensionUIResponse,
  WebExtensionUIResponseResult,
} from "./web-extension-ui-types";

export type {
  AskUserOption,
  AskUserQuestion,
  WebExtensionUIDecisionRecord,
  WebExtensionUIDialogRequest,
  WebExtensionUIEffectRequest,
  WebExtensionUIEvent,
  WebExtensionUIRequest,
  WebExtensionUIResponse,
  WebExtensionUIResponseResult,
} from "./web-extension-ui-types";

type DialogValue = string | boolean | Record<string, string> | undefined;

interface PendingDialog {
  request: WebExtensionUIDialogRequest;
  defaultValue: DialogValue;
  resolve: (value: DialogValue) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface WebExtensionUIBridgeOptions {
  theme?: ExtensionUIContext["theme"];
  emit?: (event: WebExtensionUIEvent) => void;
  record?: (record: WebExtensionUIDecisionRecord) => void | Promise<void>;
  acceptDialogs?: boolean;
}

const MAX_TEXT_RESPONSE_LENGTH = 200_000;
export const ASK_USER_TOOL_NAME = "ask_user";

export function withAskUserTool(toolNames: string[]): string[] {
  if (toolNames.length === 0 || toolNames.includes(ASK_USER_TOOL_NAME)) return [...toolNames];
  return [...toolNames, ASK_USER_TOOL_NAME];
}

function responseWithoutEnvelope(
  response: WebExtensionUIResponse | undefined,
): Omit<WebExtensionUIResponse, "type" | "id"> | undefined {
  if (!response) return undefined;
  if ("value" in response) return { value: response.value };
  if ("confirmed" in response) return { confirmed: response.confirmed };
  if ("answers" in response) return { answers: response.answers };
  return { cancelled: true };
}

function normalizedAskQuestions(questions: Array<{
  id: string;
  header?: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  allowOther?: boolean;
}>): AskUserQuestion[] {
  const seenQuestionIds = new Set<string>();
  return questions.map((question) => {
    if (seenQuestionIds.has(question.id)) {
      throw new Error(`ask_user question ids must be unique: ${question.id}`);
    }
    seenQuestionIds.add(question.id);
    const options = question.options ?? [];
    if (new Set(options.map((option) => option.label)).size !== options.length) {
      throw new Error(`ask_user option labels must be unique for question: ${question.id}`);
    }
    return {
      id: question.id,
      ...(question.header ? { header: question.header } : {}),
      question: question.question,
      options,
      // A question without choices must always have a way to be answered,
      // even if a model explicitly (and inconsistently) sent allowOther=false.
      allowOther: options.length === 0 || question.allowOther === true,
    };
  });
}

function parseResponse(
  request: WebExtensionUIDialogRequest,
  response: WebExtensionUIResponse,
): { valid: true; value: DialogValue; response: WebExtensionUIResponse } | { valid: false } {
  if ("cancelled" in response) {
    return { valid: true, value: request.method === "confirm" ? false : undefined, response };
  }

  if (request.method === "confirm") {
    return "confirmed" in response
      ? { valid: true, value: response.confirmed, response }
      : { valid: false };
  }

  if (request.method === "select") {
    return "value" in response && request.options.includes(response.value)
      ? { valid: true, value: response.value, response }
      : { valid: false };
  }

  if (request.method === "input" || request.method === "editor") {
    return "value" in response && response.value.length <= MAX_TEXT_RESPONSE_LENGTH
      ? { valid: true, value: response.value, response }
      : { valid: false };
  }

  if (!("answers" in response)) return { valid: false };
  const questionIds = new Set(request.questions.map((question) => question.id));
  const answerIds = Object.keys(response.answers);
  if (answerIds.length !== questionIds.size || answerIds.some((id) => !questionIds.has(id))) {
    return { valid: false };
  }
  for (const question of request.questions) {
    const answer = response.answers[question.id];
    if (typeof answer !== "string" || answer.trim().length === 0 || answer.length > MAX_TEXT_RESPONSE_LENGTH) {
      return { valid: false };
    }
    if (!question.allowOther && !question.options.some((option) => option.label === answer)) {
      return { valid: false };
    }
  }
  return { valid: true, value: { ...response.answers }, response };
}

/**
 * Browser-backed implementation of Pi's ExtensionUIContext.
 *
 * Pi's documented RPC contract supports select/confirm/input/editor plus
 * fire-and-forget UI events. TUI-only component factories intentionally keep
 * the same degraded behavior as Pi's own RPC mode.
 * Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#extension-ui-protocol
 */
export class WebExtensionUIBridge implements ExtensionUIContext {
  private emitter: (event: WebExtensionUIEvent) => void;
  private recorder?: (record: WebExtensionUIDecisionRecord) => void | Promise<void>;
  private themeValue?: ExtensionUIContext["theme"];
  private acceptDialogs: boolean;
  private readonly pending = new Map<string, PendingDialog>();
  private readonly statuses = new Map<string, Extract<WebExtensionUIRequest, { method: "setStatus" }>>();
  private readonly widgets = new Map<string, Extract<WebExtensionUIRequest, { method: "setWidget" }>>();
  private titleEvent?: Extract<WebExtensionUIRequest, { method: "setTitle" }>;
  private editorTextEvent?: Extract<WebExtensionUIRequest, { method: "set_editor_text" }>;

  constructor(options: WebExtensionUIBridgeOptions = {}) {
    this.themeValue = options.theme;
    this.emitter = options.emit ?? (() => {});
    this.recorder = options.record;
    this.acceptDialogs = options.acceptDialogs ?? true;
  }

  setEmitter(emit: (event: WebExtensionUIEvent) => void): void {
    this.emitter = emit;
  }

  setRecorder(record: (entry: WebExtensionUIDecisionRecord) => void | Promise<void>): void {
    this.recorder = record;
  }

  setPiTheme(theme: ExtensionUIContext["theme"]): void {
    this.themeValue = theme;
  }

  enableDialogs(): void {
    this.acceptDialogs = true;
  }

  snapshot(): WebExtensionUIEvent[] {
    const editorTextEvent = this.editorTextEvent;
    // setEditorText is a one-shot command. Keep it only until the first SSE
    // listener can receive it; replaying it on every reconnect would overwrite
    // a draft the user typed after the extension originally prefixed it.
    this.editorTextEvent = undefined;
    return [
      ...[...this.pending.values()].map(({ request }) => request),
      ...this.statuses.values(),
      ...this.widgets.values(),
      ...(this.titleEvent ? [this.titleEvent] : []),
      ...(editorTextEvent ? [editorTextEvent] : []),
    ];
  }

  acknowledgeDelivery(eventId: string): void {
    if (this.editorTextEvent?.id === eventId) this.editorTextEvent = undefined;
  }

  respond(response: WebExtensionUIResponse): WebExtensionUIResponseResult {
    if (!response || response.type !== "extension_ui_response" || typeof response.id !== "string") {
      return { accepted: false, reason: "invalid_response" };
    }
    const pending = this.pending.get(response.id);
    if (!pending) return { accepted: false, reason: "not_found" };
    const parsed = parseResponse(pending.request, response);
    if (!parsed.valid) return { accepted: false, reason: "invalid_response" };

    this.finish(pending, parsed.value, "cancelled" in response ? "cancelled" : "answered", parsed.response);
    return { accepted: true };
  }

  closeAll(): void {
    for (const pending of [...this.pending.values()]) {
      this.finish(pending, pending.defaultValue, "session_closed");
    }
  }

  /**
   * Drop session-scoped extension UI before AgentSessionRuntime replaces the
   * active session. Persistent status/widget/title state belongs to the old
   * extension runtime and must not replay into the replacement session.
   */
  resetForSessionReplacement(): void {
    this.closeAll();
    this.statuses.clear();
    this.widgets.clear();
    this.titleEvent = undefined;
    this.editorTextEvent = undefined;
  }

  select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.openDialog<string | undefined>({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "select",
      title,
      options: [...options],
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    }, undefined, opts);
  }

  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return this.openDialog<boolean>({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "confirm",
      title,
      message,
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    }, false, opts);
  }

  input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.openDialog<string | undefined>({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "input",
      title,
      ...(placeholder ? { placeholder } : {}),
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    }, undefined, opts);
  }

  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.openDialog<string | undefined>({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "editor",
      title,
      ...(prefill !== undefined ? { prefill } : {}),
    }, undefined);
  }

  askUser(questions: AskUserQuestion[], signal?: AbortSignal): Promise<Record<string, string> | undefined> {
    return this.openDialog<Record<string, string> | undefined>({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "ask_user",
      questions,
    }, undefined, signal ? { signal } : undefined);
  }

  notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    this.emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: type });
  }

  setStatus(key: string, text: string | undefined): void {
    const event = { type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text } as const;
    if (text === undefined) this.statuses.delete(key);
    else this.statuses.set(key, event);
    this.emit(event);
  }

  setWidget(
    key: string,
    content: string[] | ((...args: never[]) => unknown) | undefined,
    options?: ExtensionWidgetOptions,
  ): void {
    // Component factories require a terminal renderer and are intentionally
    // ignored in Web/RPC mode. String widgets map cleanly to browser UI.
    if (typeof content === "function") return;
    const event = {
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: content ? [...content] : undefined,
      widgetPlacement: options?.placement ?? "aboveEditor",
    } as const;
    if (content === undefined) this.widgets.delete(key);
    else this.widgets.set(key, event);
    this.emit(event);
  }

  setTitle(title: string): void {
    const event = { type: "extension_ui_request", id: randomUUID(), method: "setTitle", title } as const;
    this.titleEvent = event;
    this.emit(event);
  }

  setEditorText(text: string): void {
    const event = { type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text } as const;
    this.editorTextEvent = event;
    this.emit(event);
  }

  pasteToEditor(text: string): void { this.setEditorText(text); }
  getEditorText(): string { return ""; }
  onTerminalInput(): () => void { return () => {}; }
  setWorkingMessage(): void {}
  setWorkingVisible(): void {}
  setWorkingIndicator(): void {}
  setHiddenThinkingLabel(): void {}
  setFooter(): void {}
  setHeader(): void {}
  async custom<T>(): Promise<T> { return undefined as T; }
  addAutocompleteProvider(): void {}
  setEditorComponent(): void {}
  getEditorComponent(): undefined { return undefined; }

  get theme(): ExtensionUIContext["theme"] {
    if (!this.themeValue) throw new Error("Pi extension theme is not initialized");
    return this.themeValue;
  }

  getAllThemes(): [] { return []; }
  getTheme(): undefined { return undefined; }
  setTheme(): { success: false; error: string } {
    return { success: false, error: "Theme switching is controlled by Pi Web" };
  }
  getToolsExpanded(): boolean { return false; }
  setToolsExpanded(): void {}

  private emit(event: WebExtensionUIEvent): void {
    this.emitter(event);
  }

  private openDialog<T extends DialogValue>(
    request: WebExtensionUIDialogRequest,
    defaultValue: T,
    opts?: ExtensionUIDialogOptions,
  ): Promise<T> {
    if (!this.acceptDialogs || opts?.signal?.aborted) return Promise.resolve(defaultValue);

    return new Promise<T>((resolve) => {
      const pending: PendingDialog = {
        request,
        defaultValue,
        resolve: (value) => resolve(value as T),
        signal: opts?.signal,
      };
      if (opts?.signal) {
        pending.abortHandler = () => this.finish(pending, defaultValue, "aborted");
        opts.signal.addEventListener("abort", pending.abortHandler, { once: true });
      }
      if (opts?.timeout && opts.timeout > 0) {
        pending.timer = setTimeout(() => this.finish(pending, defaultValue, "timeout"), opts.timeout);
      }
      this.pending.set(request.id, pending);
      this.emit(request);
    });
  }

  private finish(
    pending: PendingDialog,
    value: DialogValue,
    outcome: WebExtensionUIDecisionRecord["outcome"],
    response?: WebExtensionUIResponse,
  ): void {
    if (!this.pending.delete(pending.request.id)) return;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
    this.emit({ type: "extension_ui_closed", id: pending.request.id, reason: outcome });
    const record: WebExtensionUIDecisionRecord = {
      request: pending.request,
      response: responseWithoutEnvelope(response),
      outcome,
      recordedAt: new Date().toISOString(),
    };
    try {
      void Promise.resolve(this.recorder?.(record)).catch(() => {});
    } catch {
      // Decision logging is best-effort and must never strand the agent.
    }
    pending.resolve(value);
  }
}

const AskUserOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 200, description: "Visible option label" }),
  description: Type.Optional(Type.String({ maxLength: 500, description: "Short trade-off or impact" })),
});

const AskUserQuestionSchema = Type.Object({
  id: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$", description: "Stable answer key" }),
  header: Type.Optional(Type.String({ maxLength: 40, description: "Short section label" })),
  question: Type.String({ minLength: 1, maxLength: 2_000 }),
  options: Type.Optional(Type.Array(AskUserOptionSchema, { maxItems: 6 })),
  allowOther: Type.Optional(Type.Boolean({ description: "Allow a free-form answer" })),
});

const AskUserParams = Type.Object({
  questions: Type.Array(AskUserQuestionSchema, { minItems: 1, maxItems: 3 }),
});

export function createAskUserTool(bridge: WebExtensionUIBridge) {
  return defineTool({
    name: ASK_USER_TOOL_NAME,
    label: "Ask user",
    description: "Pause and ask the user one to three focused questions when their decision is required to continue.",
    promptSnippet: "Ask the user focused questions and wait for their answers.",
    promptGuidelines: [
      "Use ask_user only when a decision materially changes the result; provide 2-3 mutually exclusive options when possible.",
    ],
    parameters: AskUserParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const questions = normalizedAskQuestions(params.questions);
      const answers = await bridge.askUser(questions, signal);
      if (!answers) {
        return {
          content: [{ type: "text", text: "The user cancelled the question." }],
          details: { cancelled: true, answers: {} },
        };
      }
      return {
        content: [{ type: "text", text: `User answers: ${JSON.stringify(answers)}` }],
        details: { cancelled: false, answers },
      };
    },
  });
}
