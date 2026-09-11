"use client";

import type {
  WebExtensionUIDialogRequest,
  WebExtensionUIEvent,
  WebExtensionUIClosedEvent,
  WebExtensionUIResponse,
  WebExtensionUIResponseResult,
  WebExtensionUIWidgetPlacement,
} from "@/lib/web-extension-ui-types";
import { isWebExtensionUIDialogRequest } from "@/lib/web-extension-ui-types";

export interface ExtensionUIState {
  dialogs: WebExtensionUIDialogRequest[];
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: WebExtensionUIWidgetPlacement }>;
}

export const initialExtensionUIState: ExtensionUIState = {
  dialogs: [],
  statuses: {},
  widgets: {},
};

type ExtensionResponseErrorKey = "extensionUI.invalidResponse" | "extensionUI.responseConflict"
  | "extensionUI.cancelled" | "extensionUI.expired" | "extensionUI.closed";

/** Successful receipts and terminal rejections must clear a stale local dialog. */
export function extensionResponseFeedback(
  response: WebExtensionUIResponse,
  result: WebExtensionUIResponseResult | undefined,
): { closed?: WebExtensionUIClosedEvent; errorKey?: ExtensionResponseErrorKey } {
  const closed = (reason: WebExtensionUIClosedEvent["reason"]): WebExtensionUIClosedEvent => ({
    type: "extension_ui_closed", id: response.id, reason,
  });
  if (result?.accepted) return { closed: closed("cancelled" in response ? "cancelled" : "answered") };
  switch (result?.reason) {
    case "response_conflict": return { closed: closed("answered"), errorKey: "extensionUI.responseConflict" };
    case "cancelled": return { closed: closed("cancelled"), errorKey: "extensionUI.cancelled" };
    case "expired":
    case "not_found": return { closed: closed("timeout"), errorKey: "extensionUI.expired" };
    case "closed": return { closed: closed("session_closed"), errorKey: "extensionUI.closed" };
    default: return { errorKey: "extensionUI.invalidResponse" };
  }
}

export type ExtensionUIAction =
  | { type: "event"; event: WebExtensionUIEvent }
  | { type: "reset" };

export function extensionUIReducer(state: ExtensionUIState, action: ExtensionUIAction): ExtensionUIState {
  if (action.type === "reset") return initialExtensionUIState;
  const event = action.event;

  if (event.type === "extension_ui_closed") {
    return { ...state, dialogs: state.dialogs.filter((dialog) => dialog.id !== event.id) };
  }
  if (isWebExtensionUIDialogRequest(event)) {
    if (state.dialogs.some((dialog) => dialog.id === event.id)) return state;
    return { ...state, dialogs: [...state.dialogs, event] };
  }
  if (event.method === "setStatus") {
    const statuses = { ...state.statuses };
    if (event.statusText === undefined) delete statuses[event.statusKey];
    else statuses[event.statusKey] = event.statusText;
    return { ...state, statuses };
  }
  if (event.method === "setWidget") {
    const widgets = { ...state.widgets };
    if (event.widgetLines === undefined) delete widgets[event.widgetKey];
    else widgets[event.widgetKey] = {
      lines: event.widgetLines,
      placement: event.widgetPlacement ?? "aboveEditor",
    };
    return { ...state, widgets };
  }
  return state;
}
