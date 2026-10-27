import { describe, expect, it } from "vitest";
import { buildSessionContext as sdkContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry as PiEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionTranscript, buildSessionContext } from "../session-context";
import { buildTree } from "../session-reader";
import { encodeSessionData, decodeSessionData } from "../session-tree-wire";
import { COMPACTION_MESSAGE_TYPE } from "../compaction-message";
import type { SessionEntry } from "../types";

const time = "2026-10-27T00:00:00Z";
const user = (id: string, parentId: string | null): SessionEntry => ({ type: "message", id, parentId, timestamp: time, message: { role: "user", content: id } });
const compact = (id: string, parentId: string, firstKeptEntryId: string): SessionEntry => ({ type: "compaction", id, parentId, timestamp: time, summary: `summary-${id}`, tokensBefore: 40000, firstKeptEntryId });
const fixture = (): SessionEntry[] => [user("old", null), user("recent", "old"), compact("compact", "recent", "recent"), user("new", "compact")];

describe("full branch transcript independent of model context", () => {
  it("preserves old entries while the official model context remains compacted and source stays unchanged", () => {
    const entries = fixture(); const before = JSON.stringify(entries);
    const transcript = buildSessionTranscript(entries);
    expect(transcript.entryIds).toEqual(["old", "recent", "compact", "new"]);
    expect(transcript.messages.map(m => m.role)).toEqual(["user", "user", "custom", "user"]);
    expect(transcript.messages[2]).toMatchObject({ customType: COMPACTION_MESSAGE_TYPE, display: true, content: "summary-compact" });
    expect(buildSessionContext(entries).entryIds).toEqual(["compact", "recent", "new"]);
    expect(sdkContext(entries as PiEntry[]).messages.some(m => m.role === "user" && m.content === "old")).toBe(false);
    expect(JSON.stringify(entries)).toBe(before);
  });

  it("retains each chronological marker once across repeated compactions", () => {
    const entries = [...fixture(), compact("compact2", "new", "new"), user("latest", "compact2")];
    const transcript = buildSessionTranscript(entries);
    expect(transcript.entryIds).toEqual(["old", "recent", "compact", "new", "compact2", "latest"]);
    expect(transcript.messages.filter(m => m.role === "user")).toHaveLength(4);
    expect(new Set(transcript.entryIds).size).toBe(transcript.messages.length);
  });

  it("keeps selected branches isolated, including a leaf before compaction and the empty root", () => {
    const entries = [...fixture(), user("sibling", "old")];
    expect(buildSessionTranscript(entries, "new").entryIds).toEqual(["old", "recent", "compact", "new"]);
    expect(buildSessionTranscript(entries, "sibling").entryIds).toEqual(["old", "sibling"]);
    expect(buildSessionTranscript(entries, "recent").entryIds).toEqual(["old", "recent"]);
    expect(buildSessionTranscript(entries, null).messages).toEqual([]);
    expect(buildSessionTranscript([]).entryIds).toEqual([]);
  });

  it("keeps image/tool identity and settings while excluding system and hidden extension instructions", () => {
    const entries = [
      { type: "message", id: "sys", parentId: null, timestamp: time, message: { role: "system", content: "PRIVATE SYSTEM" } },
      { ...user("image", "sys"), message: { role: "user", content: [{ type: "image", data: "Zml4dHVyZQ==", mimeType: "image/png" }] } },
      { type: "message", id: "call", parentId: "image", timestamp: time, message: { role: "assistant", provider: "fixture", model: "fixture", content: [{ type: "toolCall", id: "tool1", name: "read", arguments: { path: "demo.txt" } }] } },
      { type: "message", id: "result", parentId: "call", timestamp: time, message: { role: "toolResult", toolCallId: "tool1", content: [{ type: "text", text: "saved tool output" }] } },
      { type: "custom_message", id: "hidden", parentId: "result", timestamp: time, customType: "private", content: "PRIVATE INSTRUCTION", display: false },
      { type: "custom_message", id: "visible", parentId: "hidden", timestamp: time, customType: "notice", content: "shown", display: true },
      { ...compact("compact", "visible", "visible"), systemMessage: { role: "system", content: "PRIVATE RESTORED SYSTEM" } },
      { type: "model_change", id: "model", parentId: "compact", timestamp: time, provider: "new-provider", modelId: "new-model" },
      { type: "thinking_level_change", id: "thinking", parentId: "model", timestamp: time, thinkingLevel: "high" },
    ] as unknown as SessionEntry[];
    const transcript = buildSessionTranscript(entries);
    expect(transcript.entryIds).toEqual(["image", "call", "result", "visible", "compact"]);
    expect(transcript.messages[0]).toMatchObject({ content: [{ type: "image", data: "Zml4dHVyZQ==" }] });
    expect(transcript.messages[1]).toMatchObject({ content: [{ toolCallId: "tool1", toolName: "read", input: { path: "demo.txt" } }] });
    expect(transcript.messages[2]).toMatchObject({ toolCallId: "tool1" });
    expect(transcript).toMatchObject({ model: { provider: "new-provider", modelId: "new-model" }, thinkingLevel: "high" });
    expect(JSON.stringify(transcript)).not.toContain("PRIVATE");
  });

  it.each(["flat-v1", "flat-v2"] as const)("round-trips full transcript and exact source entry IDs through %s", format => {
    const entries = fixture(); const source = { context: buildSessionTranscript(entries), tree: buildTree(entries) };
    expect(decodeSessionData(JSON.parse(JSON.stringify(encodeSessionData(source, format))))).toEqual(source);
  });

  it("retains older messages when legacy compaction has no retained-entry boundary", () => {
    const entries = [user("old", null), { ...compact("compact", "old", "compact"), firstKeptEntryId: null }] as unknown as SessionEntry[];
    expect(buildSessionTranscript(entries).entryIds).toEqual(["old", "compact"]);
  });

  it("rejects cyclic parent chains instead of hanging", () => {
    expect(() => buildSessionTranscript([user("a", "b"), user("b", "a")])).toThrow("cyclic parent");
  });
});
