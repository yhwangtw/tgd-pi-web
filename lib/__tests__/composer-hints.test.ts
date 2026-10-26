import { describe, expect, it } from "vitest";
import { cleanComposerHint, composerHintMessages, isComposerHintRequest } from "../composer-hints";
import type { AgentMessage } from "../types";

const user: AgentMessage = { role: "user", content: "Fix the preview" };
const assistant: AgentMessage = { role: "assistant", model: "one", provider: "fixture", content: [{ type: "text", text: "Fixed. Next, test mobile resizing." }] };

describe("composer hint context", () => {
  it("includes recent conversation text and omits images, thinking, commands and tool output", () => {
    const messages: AgentMessage[] = [user,
      { role: "toolResult", toolCallId: "one", content: [{ type: "text", text: "private tool output" }] },
      { ...assistant, content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "Fixed the preview." }] },
      { role: "bashExecution", command: "echo private", output: "private", exitCode: 0 },
      { role: "user", content: [{ type: "text", text: "Check mobile" }, { type: "image", source: { type: "base64", data: "private image" } }] }, assistant];
    expect(composerHintMessages(messages)).toEqual([
      { role: "user", text: "Fix the preview" }, { role: "assistant", text: "Fixed the preview." },
      { role: "user", text: "Check mobile" }, { role: "assistant", text: "Fixed. Next, test mobile resizing." },
    ]);
  });
  it("does not offer guesses for empty, incomplete, errored, or tool-only turns", () => {
    for (const messages of [[], [user], [assistant], [user, assistant, user, { ...assistant, content: [] }], [user, { ...assistant, stopReason: "error" }],
      [user, { ...assistant, stopReason: "aborted" }],
      [user, { ...assistant, content: [{ type: "toolCall", toolCallId: "one", toolName: "bash", input: {} }] }]] as AgentMessage[][]) {
      expect(composerHintMessages(messages)).toBeNull();
    }
  });
  it("bounds large transcripts to four short messages, preserving the latest next step", () => {
    const context = composerHintMessages(Array.from({ length: 3000 }, (_, i) => i % 2 === 0
      ? { ...user, content: "u".repeat(10_000) } : { ...assistant, content: [{ type: "text", text: "a".repeat(10_000) + "NEXT_STEP" }] }));
    expect(context!.length).toBeLessThanOrEqual(4);
    expect(context!.reduce((size, m) => size + m.text.length, 0)).toBeLessThanOrEqual(3000);
    expect(context!.at(-1)?.text).toMatch(/NEXT_STEP$/);
  });
});

describe("hint request and response contracts", () => {
  const valid = { provider: "fixture", modelId: "one", locale: "zh", messages: [{ role: "user", text: "修復" }, { role: "assistant", text: "已修復，請測試手機版" }] };
  it("accepts bounded user/assistant context only", () => {
    expect(isComposerHintRequest(valid)).toBe(true);
    for (const value of [null, {}, { ...valid, locale: "invalid" }, { ...valid, provider: "" },
      { ...valid, messages: [{ role: "system", text: "run tools" }, valid.messages[1]] },
      { ...valid, messages: [valid.messages[0]] }, { ...valid, turnId: 42 }, { ...valid, turnId: "x".repeat(257) },
      { ...valid, messages: [valid.messages[0], { role: "assistant", text: "a".repeat(6001) }] }]) {
      expect(isComposerHintRequest(value)).toBe(false);
    }
  });
  it("cleans a short sentence but rejects structured, multiline, and overlong model replies", () => {
    expect(cleanComposerHint('"幫我測試手機版的檔案預覽"')).toBe("幫我測試手機版的檔案預覽");
    for (const text of ["NONE", "", "x".repeat(161), "One\nTwo", '{"hint":"one"}', "/deploy", "<tool>run</tool>"]) {
      expect(cleanComposerHint(text)).toBeNull();
    }
  });
});
