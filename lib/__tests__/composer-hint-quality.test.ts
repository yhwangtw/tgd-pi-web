import { describe, expect, it } from "vitest";
import { buildComposerHintContext, type ComposerHintContext } from "../composer-hint-context";
import { composerHintLocale, selectComposerHint } from "../composer-hint-prompt";
import type { ComposerHintRequest } from "../composer-hints";

const request = (context: Partial<ComposerHintContext> = {}): ComposerHintRequest => ({ provider: "fixture", modelId: "one", locale: "zh",
  messages: [{ role: "user", text: "修正手機版，保留原風格。" }, { role: "assistant", text: "修復後可檢查鍵盤操作。" }],
  context: { ...buildComposerHintContext([]), ...context } });
const candidate = (hint: string, intent = "verify", basis = "latest") => JSON.stringify({ hint, intent, basis });
describe("task-aware suggestion quality regression cases", () => {
  it("allows a grounded user request but rejects assistant voice and nonexistent evidence", () => {
    const r = request();
    expect(selectComposerHint(candidate("幫我檢查手機版的鍵盤操作。"), r)).toBe("幫我檢查手機版的鍵盤操作。");
    expect(selectComposerHint(candidate("我會先測試手機版。"), r)).toBeNull();
    expect(selectComposerHint(candidate("幫我檢查手機版。", "verify", "invented"), r)).toBeNull();
  });
  it("prioritizes diagnosis over continuing when execution failed", () => {
    const r = request({ evidence: [{ id: "e0", kind: "test", outcome: "failed" }] });
    expect(selectComposerHint(candidate("幫我找出剛才測試失敗的原因。", "diagnose", "e0"), r)).not.toBeNull();
    expect(selectComposerHint(candidate("繼續處理下一個功能。", "continue"), r)).toBeNull();
  });
  it("does not reverify successful evidence or redo completed plan steps", () => {
    const r = request({ workflow: { plan: { title: "Plan", status: "executing", steps: [
      { id: "plan0", text: "Test desktop", status: "completed" }, { id: "plan1", text: "Test mobile", status: "pending" }] } }, evidence: [{ id: "e0", kind: "test", outcome: "succeeded" }] });
    expect(selectComposerHint(candidate("Please test desktop.", "verify", "plan0"), r)).toBeNull();
    expect(selectComposerHint(candidate("Please rerun the passing test.", "verify", "e0"), r)).toBeNull();
    expect(selectComposerHint(candidate("幫我測試手機版。", "verify", "plan1"), r)).toBe("幫我測試手機版。");
  });
  it.each(["paused", "budget_limited", "complete"] as const)("respects a %s goal without suggesting resumption", status => {
    const r = request({ workflow: { goal: { objective: "Fix UI", status } } });
    expect(selectComposerHint(candidate("繼續執行剩下的工作。", "continue", "goal"), r)).toBeNull();
    expect(selectComposerHint(candidate("幫我說明目前的進度。", "review", "goal"), r)).not.toBeNull();
  });
  it.each(["planning", "ready"] as const)("keeps a %s plan in review", status => {
    const r = request({ workflow: { plan: { title: "Plan", status, steps: [] } } });
    expect(selectComposerHint(candidate("Start implementing now.", "continue"), r)).toBeNull();
    expect(selectComposerHint(candidate("幫我說明計畫的取捨。", "explain"), r)).not.toBeNull();
  });
  it("honors planning-only tools even without saved plan state", () => {
    expect(selectComposerHint(candidate("Run the tests now."), request({ planningOnly: true }))).toBeNull();
  });
  it("rejects a normalized dismissed suggestion and an already-sent user request", () => {
    const r = { ...request(), excluded: ["幫我測試手機版。"] };
    expect(selectComposerHint(candidate("幫我測試手機版！"), r)).toBeNull();
    expect(selectComposerHint(candidate(r.messages[0].text), r)).toBeNull();
  });
  it("does not invent deployment consent and respects a later no-deploy correction", () => {
    expect(selectComposerHint(candidate("同意部署，請直接發布。", "continue"), request())).toBeNull();
    expect(selectComposerHint(candidate("幫我部署。", "continue"), request())).toBeNull();
    const r = request({ earlierGoal: "幫我部署", corrections: ["不要部署，先只檢查。"] });
    expect(selectComposerHint(candidate("幫我部署。", "continue"), r)).toBeNull();
    expect(selectComposerHint(candidate("幫我檢查部署流程。", "review"), r)).not.toBeNull();
  });
  it("allows empty output instead of fabricating an unknown answer", () => {
    expect(selectComposerHint(JSON.stringify({ hint: null, intent: "clarify", basis: "latest" }), request())).toBeNull();
    expect(selectComposerHint("not JSON", request())).toBeNull();
  });
  it("replaces internal source IDs with human-readable labels and rejects unknown ones", () => {
    const r = request({ evidence: [{ id: "e0", kind: "test", outcome: "succeeded" }] });
    expect(selectComposerHint(candidate("請說明 e0 的驗證結果。", "review", "e0"), r)).toBe("請說明 剛才的測試 的驗證結果。");
    expect(selectComposerHint(candidate("請說明 e999 的結果。", "review"), r)).toBeNull();
  });
  it("does not assume verification is impossible without evidence or a declared limitation", () => {
    expect(selectComposerHint(candidate("請檢查手機版並回報無法驗證的原因。"), request())).toBeNull();
    expect(selectComposerHint(candidate("請測試手機版，若無法驗證請回報原因。"), request())).not.toBeNull();
  });
  it("keeps the latest user's language even when interface language differs", () => {
    expect(selectComposerHint(candidate("Can you show the results?", "review"), request())).toBeNull();
    const english = { ...request(), messages: [{ role: "user" as const, text: "Please review the keyboard layout." }, { role: "assistant" as const, text: "Fixed." }] };
    expect(composerHintLocale(english)).toBe("en");
    expect(composerHintLocale({ ...english, messages: [{ role: "user", text: "Please review 中文.md" }] })).toBe("en");
    expect(composerHintLocale({ ...english, messages: [{ role: "user", text: "幫我 review README.md" }] })).toBe("zh");
    expect(selectComposerHint(candidate("Can you show the results?", "review"), english)).not.toBeNull();
    expect(selectComposerHint(candidate("幫我查看結果。", "review"), english)).toBeNull();
  });
});
