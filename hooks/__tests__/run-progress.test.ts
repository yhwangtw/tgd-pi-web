import { describe, expect, it } from "vitest";
import { classifyRunProgress } from "../use-agent-connection";
import type { AgentPhase } from "../use-agent-session-types";

describe("classifyRunProgress", () => {
  const model = { kind: "waiting_model" } as const;
  const tools: AgentPhase = { kind: "running_tools", tools: [{ id: "1", name: "bash" }] };

  it("keeps ordinary model latency neutral", () => {
    expect(classifyRunProgress(89, model, "connected")).toEqual({
      idleSeconds: 89,
      attention: "normal",
      connection: "connected",
    });
  });

  it("uses delayed then stalled model thresholds", () => {
    expect(classifyRunProgress(90, model, "connected").attention).toBe("delayed");
    expect(classifyRunProgress(179, model, "connected").attention).toBe("delayed");
    expect(classifyRunProgress(180, model, "connected").attention).toBe("stalled");
  });

  it("allows tools longer quiet periods", () => {
    expect(classifyRunProgress(179, tools, "connected").attention).toBe("normal");
    expect(classifyRunProgress(180, tools, "connected").attention).toBe("delayed");
    expect(classifyRunProgress(299, tools, "connected").attention).toBe("delayed");
    expect(classifyRunProgress(300, tools, "connected").attention).toBe("stalled");
  });

  it("keeps connection health independent from quiet progress", () => {
    expect(classifyRunProgress(30, model, "reconnecting")).toEqual({
      idleSeconds: 30,
      attention: "normal",
      connection: "reconnecting",
    });
  });
});
