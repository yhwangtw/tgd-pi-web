import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSensitiveActionConfirmationsForTests } from "../sensitive-action-confirmation";

const mocks = vi.hoisted(() => ({
  runNpx: vi.fn(async () => ({ stdout: "Installation complete", stderr: "" })),
  listAllSessions: vi.fn(async () => [{ id: "session-1", cwd: "/tmp/project" }]),
}));

vi.mock("@/lib/npx", () => ({ runNpx: mocks.runNpx }));
vi.mock("@/lib/session-reader", () => ({ listAllSessions: mocks.listAllSessions }));

import { POST } from "../../app/api/skills/install/route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/skills/install", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  mocks.runNpx.mockClear();
  resetSensitiveActionConfirmationsForTests();
});

describe("Skill installation route", () => {
  it("requires a bound, one-time confirmation before invoking npx", async () => {
    const operation = { package: "acme/skills@review", scope: "project", cwd: "/tmp/project" };
    const direct = await POST(request({ phase: "execute", ...operation }));
    expect(direct.status).toBe(409);
    expect(mocks.runNpx).not.toHaveBeenCalled();

    const prepared = await POST(request({ phase: "prepare", ...operation }));
    expect(prepared.status).toBe(200);
    const payload = await prepared.json() as { confirmation: { token: string }; review: { installPath: string } };
    expect(payload.review.installPath).toBe("/tmp/project/.pi/agent/skills");

    const executed = await POST(request({
      phase: "execute",
      ...operation,
      confirmationToken: payload.confirmation.token,
    }));
    expect(executed.status).toBe(200);
    expect(mocks.runNpx).toHaveBeenCalledWith(
      ["skills", "add", "acme/skills@review", "-y", "--agent", "pi"],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );

    const replay = await POST(request({
      phase: "execute",
      ...operation,
      confirmationToken: payload.confirmation.token,
    }));
    expect(replay.status).toBe(409);
    expect(mocks.runNpx).toHaveBeenCalledTimes(1);
  });

  it("rejects arbitrary project paths before preparing", async () => {
    const response = await POST(request({
      phase: "prepare",
      package: "acme/skills@review",
      scope: "project",
      cwd: "/tmp/not-a-session",
    }));
    expect(response.status).toBe(403);
    expect(mocks.runNpx).not.toHaveBeenCalled();
  });
});
