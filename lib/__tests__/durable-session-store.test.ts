import { describe, expect, it } from "vitest";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { durableContext, durableEntries } from "../durable-session-store";

const entry = (value: object) => value as EntryRecord;
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
describe("Durable transcript projection", () => {
  it("preserves hidden extension messages and custom metadata without making them user turns", () => {
    const entries = [entry({ id: 1, kind: "pi-web.extension-message", data: { customType: "memory", content: "Private context", display: false }, model: [user("Private context")] }),
      entry({ id: 2, kind: "pi-web.extension-entry", data: { customType: "capture", data: { watermark: 1 } } })];
    expect(durableContext(entries, {}).messages).toEqual([expect.objectContaining({ role: "custom", display: false, customType: "memory" })]);
    expect(durableEntries(entries, new Date(0).toISOString())).toMatchObject([{ type: "custom_message", id: "1", parentId: null }, { type: "custom", parentId: "1", customType: "capture" }]);
  });
  it("keeps a shell result visible even when it is excluded from model context", () => {
    const entries = [entry({ id: 1, kind: "pi-web.shell", data: { command: "pwd", output: "/fixture", timestamp: 1, excludeFromContext: true } })];
    expect(durableContext(entries, {}).messages).toMatchObject([{ role: "bashExecution", command: "pwd", output: "/fixture" }]);
  });
  it("projects compaction metadata and honors a precise history message index", () => {
    const entries = [entry({ id: 1, kind: "messages", model: [user("old")] }), entry({ id: 2, kind: "pi.compaction", head: 3, model: [user("Summary")] }), entry({ id: 3, kind: "messages", model: [user("one"), user("two")] })];
    const context = durableContext(entries, {}, "3");
    expect(context.entryIds).toEqual(["2", "3"]);
    expect(context.messages[0]).toMatchObject({ role: "user", content: expect.stringContaining("compacted") });
    expect(durableEntries(entries, new Date(0).toISOString())[1]).toMatchObject({ type: "compaction", firstKeptEntryId: "3", summary: "Summary" });
  });
});
