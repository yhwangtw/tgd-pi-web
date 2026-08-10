import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  WebExtensionUIBridge,
  createAskUserTool,
  type WebExtensionUIEvent,
} from "../web-extension-ui";

const theme = {} as ExtensionUIContext["theme"];

describe("WebExtensionUIBridge", () => {
  it("emits a select request, validates the answer, and records the decision", async () => {
    const events: WebExtensionUIEvent[] = [];
    const record = vi.fn();
    const bridge = new WebExtensionUIBridge({ theme, emit: (event) => events.push(event), record });

    const answerPromise = bridge.select("Deploy target", ["Staging", "Production"]);
    const request = events[0];
    expect(request).toMatchObject({
      type: "extension_ui_request",
      method: "select",
      title: "Deploy target",
      options: ["Staging", "Production"],
    });

    const invalid = bridge.respond({
      type: "extension_ui_response",
      id: request.id,
      value: "Unknown",
    });
    expect(invalid).toEqual({ accepted: false, reason: "invalid_response" });

    const accepted = bridge.respond({
      type: "extension_ui_response",
      id: request.id,
      value: "Production",
    });
    await expect(answerPromise).resolves.toBe("Production");
    expect(accepted).toEqual({ accepted: true });
    expect(events.at(-1)).toEqual({ type: "extension_ui_closed", id: request.id, reason: "answered" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ method: "select", title: "Deploy target" }),
      response: { value: "Production" },
      outcome: "answered",
    }));
  });

  it("supports confirm, input, editor, cancellation, and abort signals", async () => {
    const events: WebExtensionUIEvent[] = [];
    const bridge = new WebExtensionUIBridge({ theme, emit: (event) => events.push(event) });

    const confirmPromise = bridge.confirm("Delete?", "This cannot be undone");
    const confirmRequest = events.at(-1)!;
    bridge.respond({ type: "extension_ui_response", id: confirmRequest.id, confirmed: true });
    await expect(confirmPromise).resolves.toBe(true);

    const inputPromise = bridge.input("Name", "Type a name");
    const inputRequest = events.at(-1)!;
    bridge.respond({ type: "extension_ui_response", id: inputRequest.id, cancelled: true });
    await expect(inputPromise).resolves.toBeUndefined();

    const editorPromise = bridge.editor("Edit release notes", "Initial text");
    const editorRequest = events.at(-1)!;
    bridge.respond({ type: "extension_ui_response", id: editorRequest.id, value: "Final text" });
    await expect(editorPromise).resolves.toBe("Final text");

    const controller = new AbortController();
    const abortedPromise = bridge.select("Pick", ["A", "B"], { signal: controller.signal });
    const abortedRequest = events.at(-1)!;
    controller.abort();
    await expect(abortedPromise).resolves.toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "extension_ui_closed", id: abortedRequest.id, reason: "aborted" });
  });

  it("replays pending dialogs and persistent status, widgets, title, and editor text", () => {
    const bridge = new WebExtensionUIBridge({ theme, emit: vi.fn() });

    void bridge.select("Choose", ["A", "B"]);
    bridge.setStatus("build", "Waiting for approval");
    bridge.setWidget("review", ["2 checks remaining"], { placement: "belowEditor" });
    bridge.setTitle("Approval required");
    bridge.setEditorText("prefilled prompt");
    bridge.notify("One-time notification", "info");

    const firstSnapshot = bridge.snapshot();
    expect(firstSnapshot).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "select", title: "Choose" }),
      expect.objectContaining({ method: "setStatus", statusKey: "build", statusText: "Waiting for approval" }),
      expect.objectContaining({ method: "setWidget", widgetKey: "review", widgetPlacement: "belowEditor" }),
      expect.objectContaining({ method: "setTitle", title: "Approval required" }),
      expect.objectContaining({ method: "set_editor_text", text: "prefilled prompt" }),
    ]));
    expect(firstSnapshot).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "notify" }),
    ]));
    expect(bridge.snapshot()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "set_editor_text" }),
    ]));
  });

  it("clears session-scoped UI when the runtime replaces its session", async () => {
    const bridge = new WebExtensionUIBridge({ theme, emit: vi.fn() });
    const answerPromise = bridge.input("Old session question");
    bridge.setStatus("build", "Running");
    bridge.setWidget("review", ["Pending"]);
    bridge.setTitle("Old session");
    bridge.setEditorText("old draft");

    bridge.resetForSessionReplacement();

    await expect(answerPromise).resolves.toBeUndefined();
    expect(bridge.snapshot()).toEqual([]);
  });
});

describe("ask_user tool", () => {
  it("asks up to three structured questions and returns answers to the model", async () => {
    const events: WebExtensionUIEvent[] = [];
    const bridge = new WebExtensionUIBridge({ theme, emit: (event) => events.push(event) });
    const tool = createAskUserTool(bridge);
    const executePromise = tool.execute(
      "tool-1",
      {
        questions: [
          {
            id: "target",
            header: "Deploy",
            question: "Where should this release go?",
            options: [
              { label: "Staging", description: "Safe validation environment" },
              { label: "Production", description: "Release to users" },
            ],
            allowOther: false,
          },
          {
            id: "note",
            header: "Context",
            question: "Any release note to preserve?",
            options: [],
            allowOther: true,
          },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );

    const request = events[0];
    expect(request).toMatchObject({
      type: "extension_ui_request",
      method: "ask_user",
      questions: expect.arrayContaining([
        expect.objectContaining({ id: "target", options: expect.any(Array) }),
      ]),
    });
    bridge.respond({
      type: "extension_ui_response",
      id: request.id,
      answers: { target: "Production", note: "Roll out after smoke tests" },
    });

    await expect(executePromise).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining('"target":"Production"') }],
      details: {
        cancelled: false,
        answers: { target: "Production", note: "Roll out after smoke tests" },
      },
    });
  });

  it("keeps free-form-only questions answerable and rejects ambiguous ids", async () => {
    const events: WebExtensionUIEvent[] = [];
    const bridge = new WebExtensionUIBridge({ theme, emit: (event) => events.push(event) });
    const tool = createAskUserTool(bridge);
    const answerPromise = tool.execute(
      "tool-free-form",
      {
        questions: [{ id: "note", question: "What should change?", options: [], allowOther: false }],
      },
      undefined,
      undefined,
      {} as never,
    );
    const request = events[0];
    expect(request).toMatchObject({
      method: "ask_user",
      questions: [expect.objectContaining({ id: "note", allowOther: true })],
    });
    expect(bridge.respond({
      type: "extension_ui_response",
      id: request.id,
      answers: { note: "   " },
    })).toEqual({ accepted: false, reason: "invalid_response" });
    bridge.respond({
      type: "extension_ui_response",
      id: request.id,
      answers: { note: "Improve the mobile flow" },
    });
    await expect(answerPromise).resolves.toMatchObject({ details: { cancelled: false } });

    await expect(tool.execute(
      "tool-duplicate",
      {
        questions: [
          { id: "target", question: "First?", options: [{ label: "A" }] },
          { id: "target", question: "Second?", options: [{ label: "B" }] },
        ],
      },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow("question ids must be unique");
  });
});
