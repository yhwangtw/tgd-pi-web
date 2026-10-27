import { describe, it, expect } from "vitest";
import { getRunError, isCompactionCancellation } from "../use-agent-session-types";

describe("getRunError", () => {
  it("ignores non-agent_end events", () => {
    expect(getRunError({ type: "message_end", messages: [{ role: "assistant", stopReason: "error" }] })).toBeNull();
  });

  it("null when there are no messages", () => {
    expect(getRunError({ type: "agent_end" })).toBeNull();
    expect(getRunError({ type: "agent_end", messages: [] })).toBeNull();
  });

  it("null when the last assistant message ended normally", () => {
    expect(getRunError({
      type: "agent_end",
      messages: [
        { role: "user" },
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "assistant", stopReason: "stop" },
      ],
    })).toBeNull();
  });

  it("returns the error text when the run ended in failure", () => {
    expect(getRunError({
      type: "agent_end",
      messages: [
        { role: "user" },
        { role: "assistant", stopReason: "error", errorMessage: "429 rate limited" },
      ],
    })).toBe("429 rate limited");
  });

  it.each(["length", "stop"])("recognizes an unfinished/empty %s response, but lets a later success win", stopReason => {
    const failure = { role: "assistant", stopReason, content: [] };
    expect(getRunError({ type: "agent_end", messages: [failure] })).not.toBeNull();
    expect(getRunError({ type: "agent_end", messages: [failure, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered" }] }] })).toBeNull();
  });

  it("falls back to a generic message when errorMessage is missing", () => {
    expect(getRunError({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error" }],
    })).toBe("Model call failed");
  });

  it("skips trailing non-assistant messages (e.g. toolResult)", () => {
    expect(getRunError({
      type: "agent_end",
      messages: [
        { role: "assistant", stopReason: "error", errorMessage: "boom" },
        { role: "toolResult" },
      ],
    })).toBe("boom");
  });
});

describe("isCompactionCancellation", () => {
  it("recognizes Pi cancellation responses without hiding real failures", () => {
    expect(isCompactionCancellation("Error: Compaction cancelled")).toBe(true);
    expect(isCompactionCancellation(new Error("request aborted"))).toBe(true);
    expect(isCompactionCancellation("Nothing to compact (session too small)")).toBe(false);
  });
});
