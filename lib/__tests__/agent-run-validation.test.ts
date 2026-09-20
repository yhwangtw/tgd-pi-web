import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateAgentRunInput } from "../agent-run-validation";

const dirs: string[] = [];

function cwd(): string {
  const value = mkdtempSync(join(tmpdir(), "pi-agent-run-cwd-"));
  dirs.push(value);
  return value;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent run validation", () => {
  it("accepts Pi's Max level but rejects unsupported Ultra", async () => {
    const base = { name: "Review", cwd: cwd(), prompt: "Inspect" };
    expect((await validateAgentRunInput({ ...base, thinkingLevel: "max" })).thinkingLevel).toBe("max");
    await expect(validateAgentRunInput({ ...base, thinkingLevel: "ultra" })).rejects.toThrow(/thinking/i);
  });
  it("AC-3.1: normalizes a safe read-only daemon run", async () => {
    const result = await validateAgentRunInput({
      name: " Review auth ",
      cwd: cwd(),
      prompt: " Inspect the project ",
    });

    expect(result.name).toBe("Review auth");
    expect(result.prompt).toBe("Inspect the project");
    expect(result.toolNames).toEqual(["read", "grep", "find", "ls", "ask_user"]);
  });

  it("AC-3.2: rejects missing workspaces, unsafe tools, and incomplete model pairs", async () => {
    const base = { name: "Review", cwd: cwd(), prompt: "Inspect" };
    await expect(validateAgentRunInput({ ...base, cwd: "/definitely/missing" })).rejects.toThrow(/does not exist/);
    await expect(validateAgentRunInput({ ...base, toolNames: ["delete_everything"] })).rejects.toThrow(/unsupported tool/);
    await expect(validateAgentRunInput({ ...base, provider: "custom" })).rejects.toThrow(/set together/);
  });

  it("AC-3.3: rejects oversized prompts at the API boundary", async () => {
    await expect(validateAgentRunInput({
      name: "Huge",
      cwd: cwd(),
      prompt: "x".repeat(200_001),
    })).rejects.toThrow(/prompt is too long/);
  });
});
