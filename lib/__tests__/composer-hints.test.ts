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
      [user, { ...assistant, stopReason: "aborted" }], [user, { ...assistant, stopReason: "length" }],
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
  it("rejects assistant promises and progress reports rather than suggesting them as user messages", () => {
    for (const text of ["我會先測清空後建議是否自動恢復。", "我來幫你檢查手機版。", "好的，我先修復這個問題。",
      "我已經完成驗證。", "已完成所有修改。", "I'll check the mobile preview.", "I’ll test it now.",
      "Let me investigate that.", "Sure, I will fix the layout.", "I've fixed the issue.", "Done."]) {
      expect(cleanComposerHint(text), text).toBeNull();
    }
  });
  it("retains user questions, direct requests, and expressions of user intent", () => {
    for (const text of ["幫我驗證清空草稿後，建議是否會自動恢復。", "請你檢查手機版的排版。", "為什麼會出現這個錯誤？",
      "我想請你先檢查效能。", "好的，幫我驗證手機版。", "Can you verify the mobile layout?", "Please check keyboard navigation.",
      "I'd like you to review this change.", "I want you to explain the result.", "Why does this happen?"]) {
      expect(cleanComposerHint(text), text).toBe(text);
    }
  });
});
