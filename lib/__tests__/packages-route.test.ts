import { beforeEach, describe, expect, it, vi } from "vitest";
import { preparePackageMutation } from "../package-confirmation";

const h = vi.hoisted(() => ({
  standard: vi.fn(), durable: vi.fn(), migrated: vi.fn(), manager: vi.fn(), reload: vi.fn(),
  list: vi.fn(), updates: vi.fn(), remove: vi.fn(),
}));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: h.standard }));
vi.mock("@/lib/durable-chat", () => ({ getDurableChat: h.durable }));
vi.mock("@/lib/durable-migration", () => ({ waitForSessionMigration: h.migrated }));
vi.mock("@/lib/durable-session-store", () => ({ isDurableSessionId: (id: string) => id.startsWith("dw_") }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/fixture/agent",
  DefaultPackageManager: class {
    constructor(options: unknown) { h.manager(options); }
    listConfiguredPackages = h.list;
    checkForAvailableUpdates = h.updates;
    removeAndPersist = h.remove;
  },
}));
vi.mock("@/lib/security-activity", () => ({ recordSecurityActivity: vi.fn() }));
import { GET, POST } from "../../app/api/packages/route";

const settings = { marker: "session-settings" };
const durableSession = () => ({ cwd: "/fixture/project", isAlive: () => true,
  getServices: () => ({ settingsManager: settings }), reloadExtensions: h.reload });
const post = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/packages", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" },
  body: JSON.stringify(body),
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.standard.mockReturnValue(undefined);
  h.durable.mockReturnValue(undefined);
  h.migrated.mockImplementation(async (id: string) => id);
  h.list.mockReturnValue([]);
  h.updates.mockResolvedValue([]);
  h.remove.mockResolvedValue(undefined);
  h.reload.mockResolvedValue(undefined);
});

describe("package management session engines", () => {
  it("lists packages using the active Durable session settings", async () => {
    h.durable.mockReturnValue(durableSession());
    const response = await GET(new Request("http://localhost/api/packages?sessionId=dw_active"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ packages: [] });
    expect(h.manager).toHaveBeenCalledWith({ cwd: "/fixture/project", agentDir: "/fixture/agent", settingsManager: settings });
    expect(h.standard).not.toHaveBeenCalled();
  });

  it("keeps Standard settings and follows a migrated session URL", async () => {
    h.standard.mockReturnValue({ cwd: "/fixture/project", isAlive: () => true, inner: { settingsManager: settings } });
    expect((await GET(new Request("http://localhost/api/packages?sessionId=legacy"))).status).toBe(200);
    expect(h.standard).toHaveBeenCalledWith("legacy");
    h.migrated.mockResolvedValue("dw_migrated");
    h.durable.mockReturnValue(durableSession());
    expect((await GET(new Request("http://localhost/api/packages?sessionId=legacy"))).status).toBe(200);
    expect(h.durable).toHaveBeenCalledWith("dw_migrated");
  });

  it("rejects closed or uninitialized Durable sessions", async () => {
    for (const session of [undefined, { ...durableSession(), isAlive: () => false }, { ...durableSession(), getServices: () => undefined }]) {
      h.durable.mockReturnValue(session);
      expect((await GET(new Request("http://localhost/api/packages?sessionId=dw_inactive"))).status).toBe(409);
    }
    expect(h.manager).not.toHaveBeenCalled();
  });

  it("checks available updates for an active Durable session", async () => {
    h.durable.mockReturnValue(durableSession());
    expect((await post({ sessionId: "dw_active", action: "check_updates" })).status).toBe(200);
    expect(h.updates).toHaveBeenCalledOnce();
  });

  it("requires confirmation and reloads Durable extensions after a confirmed removal", async () => {
    h.durable.mockReturnValue(durableSession());
    h.list.mockReturnValue([{ source: "npm:example", scope: "user", filtered: false }]);
    const operation = { sessionId: "dw_active", action: "remove" as const, source: "npm:example" };
    expect((await post({ ...operation, phase: "execute" })).status).toBe(409);
    expect(h.remove).not.toHaveBeenCalled();
    const { token } = preparePackageMutation(operation);
    expect((await post({ ...operation, phase: "execute", confirmationToken: token })).status).toBe(200);
    expect(h.remove).toHaveBeenCalledWith("npm:example");
    expect(h.reload).toHaveBeenCalledOnce();
    expect((await post({ ...operation, phase: "execute", confirmationToken: token })).status).toBe(409);
    expect(h.remove).toHaveBeenCalledOnce();
  });
});
