import { describe, expect, it } from "vitest";
import { AgentEventLog } from "../agent-event-log";
import { AgentStreamDecoder, AgentStreamTransport, createAgentMessageDelta, type AgentMessageDelta } from "../agent-stream-wire";

function update(text: string, count = 1, standard = true) {
  const message = { role: "assistant", content: [{ type: "thinking", thinking: "private synthetic reasoning", thinkingSignature: "preserve-signature" },
    { type: "text", text }, { type: "toolCall", id: "call", name: "test", arguments: { nested: [1, "same"] } }],
  api: "synthetic", provider: "offline", model: "fixture", usage: { output: count, cost: { total: count / 1000 } }, timestamp: 1, custom: { preserve: true } };
  return { type: "message_update", message, ...(standard ? { assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: String(count), partial: message } } : {}) };
}
function decode(decoder: AgentStreamDecoder, data: string, id: string) { return decoder.decode(JSON.parse(data), data, id); }

describe("negotiated incremental agent messages", () => {
  it.each([true, false])("round-trips every provider field, changing usage and nested tool arguments (standard=%s)", standard => {
    const log = new AgentEventLog("epoch");
    const transport = new AgentStreamTransport(true);
    const decoder = new AgentStreamDecoder();
    const first = update('台灣 😀 "quotes"\n'.repeat(200), 1, standard);
    const second = update(first.message.content[1].text + ' extra 👋\\', 2, standard);
    second.message.content[2].arguments!.nested.push("changed");
    for (const value of [first, second]) {
      const record = log.append(value);
      const frame = transport.select(record, record.type!);
      expect(decode(decoder, frame.data, frame.id!)).toEqual(value);
      if (value === second) expect(JSON.parse(frame.data).type).toBe("message_update_delta");
    }
  });

  it("uses immutable raw JSON even if the SDK and downstream event objects mutate", () => {
    const decoder = new AgentStreamDecoder();
    const log = new AgentEventLog("epoch");
    const event = update("a".repeat(2000));
    const first = log.append(event);
    const delivered = decode(decoder, first.data, first.id!);
    (delivered.message as { custom: unknown }).custom = "mutated by client";
    event.message.content[1].text += "next";
    const second = log.append(event);
    expect(decode(decoder, second.delta!.data, second.id!)).toEqual(event);
    expect(JSON.parse(log.replay("epoch:0").records[0].data).message.content[1].text).toBe("a".repeat(2000));
    expect(Object.isFrozen(second.delta)).toBe(true);
  });

  it("keeps legacy payloads, sends a full replay baseline, and resets at snapshots and message boundaries", () => {
    const log = new AgentEventLog("epoch");
    const first = log.append(update("a".repeat(2000)));
    const next = log.append(update("a".repeat(2000) + "next", 2));
    expect(next.delta).toBeDefined();
    expect(new AgentStreamTransport(false).select(next, "message_update").data).toBe(next.data);
    const replay = new AgentStreamTransport(true);
    expect(replay.select(next, "message_update").data).toBe(next.data);
    replay.select({ id: next.id, type: "session_snapshot", data: "{}" }, "session_snapshot");
    const third = log.append(update("a".repeat(2000) + "third", 3));
    expect(replay.select(third, "message_update").data).toBe(third.data);
    const decoder = new AgentStreamDecoder();
    decode(decoder, first.data, first.id!);
    decode(decoder, JSON.stringify({ type: "message_end", message: first }), "epoch:9");
    expect(() => decode(decoder, next.delta!.data, next.id!)).toThrow("snapshot");
    log.append({ type: "message_start" });
    expect(log.append(update("another".repeat(500))).delta).toBeUndefined();
  });

  it("retains the correct base across interleaved usage/tool events and preserves complete terminal frames", () => {
    const log = new AgentEventLog("epoch");
    const transport = new AgentStreamTransport(true);
    const decoder = new AgentStreamDecoder();
    const values = [update("a".repeat(1000)), { type: "usage_changed", usage: { output: 1 } },
      update("a".repeat(1000) + "b", 2), { type: "message_end", message: update("done").message }, { type: "agent_end", messages: [] }];
    for (const value of values) {
      const record = log.append(value);
      const transmitted = transport.select(record, record.type!);
      expect(decode(decoder, transmitted.data, record.id!)).toEqual(value);
      if (value.type.endsWith("end")) expect(transmitted.data).toBe(record.data);
    }
  });

  it("validates bases, formats, offsets, lengths and reconstructed event types", () => {
    const before = JSON.stringify(update("a".repeat(1000)));
    const next = JSON.stringify(update("a".repeat(1000) + "b", 2));
    const valid = JSON.parse(createAgentMessageDelta(before, next, "epoch:1")) as AgentMessageDelta;
    const invalid: unknown[] = [
      { ...valid, baseCursor: "other:1" }, { ...valid, format: "unknown" }, { ...valid, length: next.length + 1 },
      { ...valid, edits: null }, { ...valid, edits: Array(17).fill({ start: 0, remove: 0, insert: "" }) },
      ...[-1, 0.5, before.length + 1].map(start => ({ ...valid, edits: [{ start, remove: 0, insert: "" }] })),
      ...[-1, 0.5, before.length + 1].map(remove => ({ ...valid, edits: [{ start: 0, remove, insert: "" }] })),
      { ...valid, edits: [{ start: 2, remove: 3, insert: "" }, { start: 1, remove: 0, insert: "" }] },
      { ...valid, edits: [{ start: 0, remove: before.length, insert: '{"type":"message_end"}' }], length: 22 },
      { ...valid, edits: [{ start: 0, remove: before.length, insert: "not json" }], length: 8 },
    ];
    for (const value of invalid) {
      const decoder = new AgentStreamDecoder();
      decode(decoder, before, "epoch:1");
      expect(() => decoder.decode(value, JSON.stringify(value), "epoch:2")).toThrow();
    }
    expect(() => decode(new AgentStreamDecoder(), JSON.stringify(valid), "epoch:2")).toThrow("snapshot");
    expect(() => decode(new AgentStreamDecoder(), "null", "epoch:1")).toThrow();
  });

  it("round-trips deterministic arbitrary edits, reordered fields and surrogate boundaries", () => {
    let seed = 7;
    const random = (size: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % size; };
    let content = "😀台灣\\\"\n".repeat(600);
    for (let index = 0; index < 150; index++) {
      const before = JSON.stringify({ type: "message_update", message: { content }, partial: { content } });
      const start = random(content.length + 1);
      content = content.slice(0, start) + ["😁", "\n\\\"", "text".repeat(1500), ""][random(4)] + content.slice(Math.min(content.length, start + random(100)));
      const after = JSON.stringify(index % 3 ? { type: "message_update", message: { content }, partial: { content } } : { message: { content }, type: "message_update", partial: { content } });
      const decoder = new AgentStreamDecoder();
      decode(decoder, before, "epoch:1");
      expect(decode(decoder, createAgentMessageDelta(before, after, "epoch:1"), "epoch:2")).toEqual(JSON.parse(after));
    }
  });

  it.each([true, false])("reduces 128 KiB output wire bytes without truncation (standard=%s)", standard => {
    const log = new AgentEventLog("synthetic");
    const transport = new AgentStreamTransport(true);
    const decoder = new AgentStreamDecoder();
    let legacy = 0;
    let incremental = 0;
    let text = "";
    for (let index = 0; index < 1000; index++) {
      text += "x".repeat(128);
      const event = update(text, index, standard);
      const record = log.append(event);
      const transmitted = transport.select(record, record.type!);
      legacy += Buffer.byteLength(record.data);
      incremental += Buffer.byteLength(transmitted.data);
      expect(decode(decoder, transmitted.data, record.id!)).toEqual(event);
    }
    expect(text).toHaveLength(128000);
    expect(incremental).toBeLessThan(legacy * 0.05);
    console.info(JSON.stringify({ fixture: standard ? "standard-sdk-duplicated-partial" : "durable", updates: 1000, outputCharacters: text.length, legacyBytes: legacy, incrementalBytes: incremental, reductionPercent: Math.round((1 - incremental / legacy) * 10000) / 100 }));
  });
});
