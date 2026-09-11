export type WebExtensionUINotifyType = "info" | "warning" | "error";
export type WebExtensionUIWidgetPlacement = "aboveEditor" | "belowEditor";

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  id: string;
  header?: string;
  question: string;
  options: AskUserOption[];
  allowOther: boolean;
}

interface WebExtensionUIRequestBase {
  type: "extension_ui_request";
  id: string;
}

export type WebExtensionUIDialogRequest =
  | (WebExtensionUIRequestBase & {
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    })
  | (WebExtensionUIRequestBase & {
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    })
  | (WebExtensionUIRequestBase & {
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    })
  | (WebExtensionUIRequestBase & {
      method: "editor";
      title: string;
      prefill?: string;
    })
  | (WebExtensionUIRequestBase & {
      method: "ask_user";
      questions: AskUserQuestion[];
    });

export type WebExtensionUIEffectRequest =
  | (WebExtensionUIRequestBase & {
      method: "notify";
      message: string;
      notifyType?: WebExtensionUINotifyType;
    })
  | (WebExtensionUIRequestBase & {
      method: "setStatus";
      statusKey: string;
      statusText: string | undefined;
    })
  | (WebExtensionUIRequestBase & {
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: WebExtensionUIWidgetPlacement;
    })
  | (WebExtensionUIRequestBase & {
      method: "setTitle";
      title: string;
    })
  | (WebExtensionUIRequestBase & {
      method: "set_editor_text";
      text: string;
    });

export type WebExtensionUIRequest = WebExtensionUIDialogRequest | WebExtensionUIEffectRequest;

export interface WebExtensionUIClosedEvent {
  type: "extension_ui_closed";
  id: string;
  reason: "answered" | "cancelled" | "aborted" | "timeout" | "session_closed";
}

export type WebExtensionUIEvent = WebExtensionUIRequest | WebExtensionUIClosedEvent;

export type WebExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; answers: Record<string, string> }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type WebExtensionUIResponseResult =
  | { accepted: true; receipt?: "already_answered" | "already_cancelled" }
  | { accepted: false; reason: "invalid_response" | "not_found" | "response_conflict" | "cancelled" | "expired" | "closed" };

export interface WebExtensionUIDecisionRecord {
  request: WebExtensionUIDialogRequest;
  response?: Omit<WebExtensionUIResponse, "type" | "id">;
  outcome: WebExtensionUIClosedEvent["reason"];
  recordedAt: string;
}

export function isWebExtensionUIEvent(event: { type?: unknown }): event is WebExtensionUIEvent {
  return event.type === "extension_ui_request" || event.type === "extension_ui_closed";
}

export function isWebExtensionUIDialogRequest(
  event: WebExtensionUIEvent,
): event is WebExtensionUIDialogRequest {
  return event.type === "extension_ui_request"
    && (event.method === "select"
      || event.method === "confirm"
      || event.method === "input"
      || event.method === "editor"
      || event.method === "ask_user");
}
