import { afterEach, describe, expect, it, vi } from "vitest";
import { WebExtensionUIBridge } from "../web-extension-ui";
import type { WebExtensionUIEvent, WebExtensionUIResponse } from "../web-extension-ui-types";

afterEach(() => vi.useRealTimers());

function fixture() {
  const events: WebExtensionUIEvent[] = [];
  const record = vi.fn();
  const bridge = new WebExtensionUIBridge({ emit: event => events.push(event), record });
  return { bridge, events, record };
}

describe("extension UI response receipts", () => {
  it("confirms a lost-response retry after reconnect without repeating the decision or waking twice", async () => {
    const { bridge, events, record } = fixture();
    const wake = vi.fn();
    const done = bridge.askUser([
      { id: "target", question: "Where?", options: [{ label: "Staging" }], allowOther: false },
      { id: "note", question: "Note?", options: [], allowOther: true },
    ]).then(wake);
    const id = events[0].id;
    const first = { type: "extension_ui_response" as const, id, answers: { target: "Staging", note: "Private note" } };

    // The server commits this response, but the browser never receives its ACK.
    expect(bridge.respond(first)).toEqual({ accepted: true });
    expect(bridge.snapshot()).toEqual([]);
    // A second tab/retry may serialize the same answer keys in a different order.
    const retried = bridge.respond({ ...first, answers: { note: "Private note", target: "Staging" } });
    expect(retried).toEqual({ accepted: true, receipt: "already_answered" });
    expect(JSON.stringify(retried)).not.toContain("Private note");
    await done;
    expect(wake).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === "extension_ui_closed")).toHaveLength(1);
  });

  it("does not let a second tab replace the accepted answer or cancellation state", async () => {
    const { bridge, events, record } = fixture();
    const answer = bridge.select("Pick", ["A", "B"]);
    const id = events[0].id;
    const response = { type: "extension_ui_response" as const, id, value: "A" };
    expect(bridge.respond(response)).toEqual({ accepted: true });
    expect(bridge.respond(response)).toEqual({ accepted: true, receipt: "already_answered" });
    expect(bridge.respond({ ...response, value: "B" })).toEqual({ accepted: false, reason: "response_conflict" });
    expect(bridge.respond({ type: "extension_ui_response", id, cancelled: true })).toEqual({ accepted: false, reason: "response_conflict" });
    await expect(answer).resolves.toBe("A");
    expect(record).toHaveBeenCalledOnce();
  });

  it("commits the receipt before a close-event listener can retry synchronously", async () => {
    const record = vi.fn();
    let response: WebExtensionUIResponse;
    const retries: unknown[] = [];
    const bridge = new WebExtensionUIBridge({
      record,
      emit: event => {
        if (event.type === "extension_ui_request") response = { type: "extension_ui_response", id: event.id, confirmed: true };
        else retries.push(bridge.respond(response));
      },
    });
    const answer = bridge.confirm("Confirm", "Continue?");
    expect(bridge.respond(response!)).toEqual({ accepted: true });
    await expect(answer).resolves.toBe(true);
    expect(retries).toEqual([{ accepted: true, receipt: "already_answered" }]);
    expect(record).toHaveBeenCalledOnce();
  });

  it.each(["confirm", "input", "editor"] as const)("replays %s receipts", async method => {
    const { bridge, events, record } = fixture();
    const answer = method === "confirm" ? bridge.confirm("Continue?", "Confirm")
      : method === "editor" ? bridge.editor("Edit") : bridge.input("Name");
    const response: WebExtensionUIResponse = method === "confirm"
      ? { type: "extension_ui_response", id: events[0].id, confirmed: false }
      : { type: "extension_ui_response", id: events[0].id, value: "Private text" };
    bridge.respond(response);
    expect(bridge.respond(response)).toEqual({ accepted: true, receipt: "already_answered" });
    await answer;
    expect(record).toHaveBeenCalledOnce();
  });

  it("confirms repeated cancellation but distinguishes it from an expired question", async () => {
    const { bridge, events, record } = fixture();
    const answer = bridge.input("Name");
    const id = events[0].id;
    const cancel = { type: "extension_ui_response" as const, id, cancelled: true as const };
    expect(bridge.respond(cancel)).toEqual({ accepted: true });
    expect(bridge.respond(cancel)).toEqual({ accepted: true, receipt: "already_cancelled" });
    expect(bridge.respond({ type: "extension_ui_response", id, value: "Late answer" })).toEqual({ accepted: false, reason: "cancelled" });
    await expect(answer).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledOnce();
  });

  it("distinguishes timed-out and aborted dialogs without accepting late answers", async () => {
    vi.useFakeTimers();
    const { bridge, events, record } = fixture();
    const timed = bridge.input("Timed question", undefined, { timeout: 20 });
    const timedId = events[0].id;
    await vi.advanceTimersByTimeAsync(20);
    await expect(timed).resolves.toBeUndefined();
    expect(bridge.respond({ type: "extension_ui_response", id: timedId, value: "Late" })).toEqual({ accepted: false, reason: "expired" });

    const controller = new AbortController();
    const aborted = bridge.input("Aborted", undefined, { signal: controller.signal });
    const abortedId = events.at(-1)!.id;
    controller.abort();
    await expect(aborted).resolves.toBeUndefined();
    expect(bridge.respond({ type: "extension_ui_response", id: abortedId, value: "Late" })).toEqual({ accepted: false, reason: "closed" });
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("keeps receipts across snapshots, expires them after ten minutes, and never extends TTL on retries", async () => {
    vi.useFakeTimers();
    const { bridge, events, record } = fixture();
    const answer = bridge.input("Name");
    const response = { type: "extension_ui_response" as const, id: events[0].id, value: "Name" };
    bridge.respond(response);
    await answer;
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    bridge.snapshot();
    expect(bridge.respond(response)).toEqual({ accepted: true, receipt: "already_answered" });
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.respond(response)).toEqual({ accepted: false, reason: "not_found" });
    expect(record).toHaveBeenCalledOnce();
  });

  it("retains at most 256 completed receipts and clears them at session replacement", async () => {
    const { bridge, events } = fixture();
    let first: WebExtensionUIResponse | undefined;
    let newest: WebExtensionUIResponse | undefined;
    for (let index = 0; index < 257; index++) {
      const answer = bridge.input("Name");
      newest = { type: "extension_ui_response", id: events.at(-1)!.id, value: String(index) };
      first ??= newest;
      bridge.respond(newest);
      await answer;
    }
    expect(bridge.respond(first!)).toEqual({ accepted: false, reason: "not_found" });
    expect(bridge.respond(newest!)).toEqual({ accepted: true, receipt: "already_answered" });
    bridge.resetForSessionReplacement();
    expect(bridge.respond(newest!)).toEqual({ accepted: false, reason: "not_found" });
    expect(bridge.snapshot()).toEqual([]);
  });

  it("rejects malformed response payloads before storing a receipt or resolving a question", async () => {
    const { bridge, events, record } = fixture();
    const answer = bridge.confirm("Confirm", "Continue?");
    const id = events[0].id;
    for (const payload of [{ confirmed: "yes" }, { cancelled: false }, { confirmed: true, cancelled: true }, { answers: null }]) {
      expect(bridge.respond({ type: "extension_ui_response", id, ...payload } as unknown as WebExtensionUIResponse))
        .toEqual({ accepted: false, reason: "invalid_response" });
    }
    expect(record).not.toHaveBeenCalled();
    expect(bridge.snapshot()).toEqual([events[0]]);
    expect(bridge.respond({ type: "extension_ui_response", id, confirmed: true })).toEqual({ accepted: true });
    await expect(answer).resolves.toBe(true);
  });
});
