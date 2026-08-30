import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSensitiveActionConfirmationsForTests } from "../sensitive-action-confirmation";

const mocks = vi.hoisted(() => {
  const server = {
    id: "local-files",
    name: "Local files",
    enabled: false,
    scope: "global",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/project"],
    timeoutMs: 15_000,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
  return {
    server,
    testMcpServer: vi.fn(async () => ({
      id: server.id,
      state: "connected" as const,
      toolCount: 1,
      tools: [{ name: "read_file" }],
    })),
  };
});

vi.mock("@/lib/mcp", () => ({
  deleteMcpServer: vi.fn(),
  getMcpStatuses: vi.fn(() => []),
  readMcpServers: vi.fn(async () => [mocks.server]),
  refreshMcpServer: vi.fn(),
  saveMcpServer: vi.fn(),
  testMcpServer: mocks.testMcpServer,
  validateMcpServer: vi.fn((input: Record<string, unknown>, existing?: Record<string, unknown>) => ({ ...existing, ...input })),
}));

vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: vi.fn(() => undefined) }));

import { POST } from "../../app/api/mcp/route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/mcp", {
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
  mocks.testMcpServer.mockClear();
  resetSensitiveActionConfirmationsForTests();
});

describe("MCP route local command confirmation", () => {
  it("blocks a stdio test until the exact one-time confirmation is consumed", async () => {
    const direct = await POST(request({ action: "test", id: mocks.server.id }));
    expect(direct.status).toBe(409);
    expect(mocks.testMcpServer).not.toHaveBeenCalled();

    const prepared = await POST(request({ action: "test", phase: "prepare", id: mocks.server.id }));
    expect(prepared.status).toBe(200);
    const payload = await prepared.json() as { confirmation: { token: string }; review: { command: string } };
    expect(payload.review.command).toBe("npx");

    const executed = await POST(request({
      action: "test",
      phase: "execute",
      id: mocks.server.id,
      confirmationToken: payload.confirmation.token,
    }));
    expect(executed.status).toBe(200);
    expect(mocks.testMcpServer).toHaveBeenCalledTimes(1);

    const replay = await POST(request({
      action: "test",
      phase: "execute",
      id: mocks.server.id,
      confirmationToken: payload.confirmation.token,
    }));
    expect(replay.status).toBe(409);
    expect(mocks.testMcpServer).toHaveBeenCalledTimes(1);
  });
});
