import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebExtensionUIBridge } from "../web-extension-ui";
import type { WebExtensionUIEvent, WebExtensionUIResponse } from "../web-extension-ui-types";

const mocks = vi.hoisted(() => ({ send: vi.fn(), startRpcSession: vi.fn(), resolveSessionPath: vi.fn() }));
vi.mock("@/lib/rpc-manager", () => ({
  getRpcSession: () => ({ isAlive: () => true, send: mocks.send }),
  startRpcSession: mocks.startRpcSession,
}));
vi.mock("@/lib/session-reader", () => ({ resolveSessionPath: mocks.resolveSessionPath }));

import { POST } from "../../app/api/agent/[id]/route";

beforeEach(() => vi.clearAllMocks());

describe("extension response route retry", () => {
  it("acknowledges an already committed answer after its HTTP response was lost", async () => {
    const events: WebExtensionUIEvent[] = [];
    const record = vi.fn();
    const bridge = new WebExtensionUIBridge({ emit: event => events.push(event), record });
    mocks.send.mockImplementation((command: WebExtensionUIResponse) => bridge.respond(command));
    const answer = bridge.input("Fixture question");
    const response: WebExtensionUIResponse = { type: "extension_ui_response", id: events[0].id, value: "Private fixture answer" };
    const post = (body = response) => POST(new Request("http://localhost/api/agent/fixture", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: "fixture" }) });

    // Discard the first successful response as though the transport lost it.
    await post();
    expect(bridge.snapshot()).toEqual([]);
    const retry = await post();
    expect(retry.status).toBe(200);
    const receipt = await retry.json();
    expect(receipt).toEqual({ success: true, data: { accepted: true, receipt: "already_answered" } });
    expect(JSON.stringify(receipt)).not.toContain("Private fixture answer");
    await expect(answer).resolves.toBe("Private fixture answer");
    expect(record).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === "extension_ui_closed")).toHaveLength(1);
    expect(mocks.startRpcSession).not.toHaveBeenCalled();
    expect(mocks.resolveSessionPath).not.toHaveBeenCalled();
  });

  it("serializes simultaneous tab answers and never starts a real runtime", async () => {
    const events: WebExtensionUIEvent[] = [];
    const record = vi.fn();
    const bridge = new WebExtensionUIBridge({ emit: event => events.push(event), record });
    mocks.send.mockImplementation((command: WebExtensionUIResponse) => bridge.respond(command));
    const answer = bridge.select("Fixture question", ["A", "B"]);
    const id = events[0].id;
    const post = (value: string) => POST(new Request("http://localhost/api/agent/fixture", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "extension_ui_response", id, value }),
    }), { params: Promise.resolve({ id: "fixture" }) });
    const results = await Promise.all([post("A"), post("B")]);
    const receipts = await Promise.all(results.map(result => result.json()));
    expect(receipts).toContainEqual({ success: true, data: { accepted: true } });
    expect(receipts).toContainEqual({ success: true, data: { accepted: false, reason: "response_conflict" } });
    const chosen = await answer;
    expect(["A", "B"]).toContain(chosen);
    expect(record).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === "extension_ui_closed")).toHaveLength(1);
    expect(mocks.startRpcSession).not.toHaveBeenCalled();
    expect(mocks.resolveSessionPath).not.toHaveBeenCalled();
  });
});
