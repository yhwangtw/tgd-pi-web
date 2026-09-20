import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initialNextRunAt, validateScheduleInput } from "../schedule-validation";

const dirs: string[] = [];

function cwd(): string {
  const value = mkdtempSync(join(tmpdir(), "pi-schedule-cwd-"));
  dirs.push(value);
  return value;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("schedule validation", () => {
  it("accepts Pi's Max level but rejects unsupported Ultra", async () => {
    const base = { name: "Review", cwd: cwd(), prompt: "Inspect", timing: { kind: "daily", time: "09:00" }, timezone: "UTC" };
    expect((await validateScheduleInput({ ...base, thinkingLevel: "max" })).thinkingLevel).toBe("max");
    await expect(validateScheduleInput({ ...base, thinkingLevel: "ultra" })).rejects.toThrow(/thinking/i);
  });
  it("normalizes a safe read-only schedule", async () => {
    const input = await validateScheduleInput({
      name: " Review ",
      cwd: cwd(),
      prompt: "Inspect the project",
      timing: { kind: "daily", time: "09:00" },
      timezone: "Asia/Taipei",
    });
    expect(input.name).toBe("Review");
    expect(input.toolNames).toEqual(["read", "grep", "find", "ls", "ask_user"]);
    expect(initialNextRunAt(input, new Date("2026-07-23T00:30:00.000Z"))).toBe("2026-07-23T01:00:00.000Z");
  });

  it("rejects missing projects, unsafe tools, and incomplete model pairs", async () => {
    const base = {
      name: "Review",
      cwd: cwd(),
      prompt: "Inspect",
      timing: { kind: "daily", time: "09:00" },
      timezone: "UTC",
    };
    await expect(validateScheduleInput({ ...base, cwd: "/definitely/missing" })).rejects.toThrow(/does not exist/);
    await expect(validateScheduleInput({ ...base, toolNames: ["delete_everything"] })).rejects.toThrow(/unsupported tool/);
    await expect(validateScheduleInput({ ...base, provider: "custom" })).rejects.toThrow(/set together/);
  });

  it("rejects malformed weekday values instead of silently dropping them", async () => {
    await expect(validateScheduleInput({
      name: "Weekly",
      cwd: cwd(),
      prompt: "Inspect",
      timing: { kind: "weekly", time: "09:00", weekdays: [1, "2"] },
      timezone: "UTC",
    })).rejects.toThrow(/weekdays/);
  });

  it("rejects one-time schedules that are already past", async () => {
    const input = await validateScheduleInput({
      name: "Past",
      cwd: cwd(),
      prompt: "Inspect",
      timing: { kind: "once", date: "2026-07-22", time: "09:00" },
      timezone: "UTC",
    });
    expect(() => initialNextRunAt(input, new Date("2026-07-23T00:00:00.000Z"))).toThrow(/future/);
  });
});
