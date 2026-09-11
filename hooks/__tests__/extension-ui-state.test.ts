import { describe, expect, it } from "vitest";
import { extensionUIReducer, extensionResponseFeedback, initialExtensionUIState } from "../use-extension-ui";

describe("extensionUIReducer", () => {
  it("queues dialog requests once and removes them when closed", () => {
    const request = {
      type: "extension_ui_request" as const,
      id: "question-1",
      method: "select" as const,
      title: "Choose",
      options: ["A", "B"],
    };
    const queued = extensionUIReducer(initialExtensionUIState, { type: "event", event: request });
    const deduped = extensionUIReducer(queued, { type: "event", event: request });
    expect(deduped.dialogs).toEqual([request]);

    const closed = extensionUIReducer(deduped, {
      type: "event",
      event: { type: "extension_ui_closed", id: "question-1", reason: "answered" },
    });
    expect(closed.dialogs).toEqual([]);
  });

  it("keeps status and widget state by extension key", () => {
    const withStatus = extensionUIReducer(initialExtensionUIState, {
      type: "event",
      event: {
        type: "extension_ui_request",
        id: "status-1",
        method: "setStatus",
        statusKey: "review",
        statusText: "Waiting",
      },
    });
    const withWidget = extensionUIReducer(withStatus, {
      type: "event",
      event: {
        type: "extension_ui_request",
        id: "widget-1",
        method: "setWidget",
        widgetKey: "review",
        widgetLines: ["2 checks remaining"],
        widgetPlacement: "aboveEditor",
      },
    });
    expect(withWidget.statuses).toEqual({ review: "Waiting" });
    expect(withWidget.widgets).toEqual({
      review: { lines: ["2 checks remaining"], placement: "aboveEditor" },
    });

    const cleared = extensionUIReducer(withWidget, {
      type: "event",
      event: {
        type: "extension_ui_request",
        id: "status-2",
        method: "setStatus",
        statusKey: "review",
        statusText: undefined,
      },
    });
    expect(cleared.statuses).toEqual({});
  });

  it("clears stale state before an SSE reconnect snapshot is replayed", () => {
    const stale = {
      dialogs: [],
      statuses: { old: "stale" },
      widgets: { old: { lines: ["stale"], placement: "aboveEditor" as const } },
    };
    expect(extensionUIReducer(stale, { type: "reset" })).toEqual(initialExtensionUIState);
  });
});

describe("extension response feedback", () => {
  const response = { type: "extension_ui_response" as const, id: "question-1", value: "Private answer" };

  it("closes a successfully retried answer without an error or answer echo", () => {
    expect(extensionResponseFeedback(response, { accepted: true, receipt: "already_answered" })).toEqual({
      closed: { type: "extension_ui_closed", id: "question-1", reason: "answered" },
    });
    expect(extensionResponseFeedback({ type: "extension_ui_response", id: "question-1", cancelled: true }, {
      accepted: true, receipt: "already_cancelled",
    })).toEqual({ closed: { type: "extension_ui_closed", id: "question-1", reason: "cancelled" } });
  });

  it.each([
    ["response_conflict", "extensionUI.responseConflict", "answered"],
    ["cancelled", "extensionUI.cancelled", "cancelled"],
    ["expired", "extensionUI.expired", "timeout"],
    ["not_found", "extensionUI.expired", "timeout"],
    ["closed", "extensionUI.closed", "session_closed"],
  ] as const)("closes terminal %s state with distinct feedback", (reason, errorKey, closedReason) => {
    expect(extensionResponseFeedback(response, { accepted: false, reason })).toEqual({
      errorKey,
      closed: { type: "extension_ui_closed", id: "question-1", reason: closedReason },
    });
  });

  it("preserves a malformed answer for correction, rather than closing the pending question", () => {
    expect(extensionResponseFeedback(response, { accepted: false, reason: "invalid_response" })).toEqual({
      errorKey: "extensionUI.invalidResponse",
    });
    expect(extensionResponseFeedback(response, undefined)).toEqual({ errorKey: "extensionUI.invalidResponse" });
  });
});
