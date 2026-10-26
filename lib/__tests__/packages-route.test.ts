import { beforeEach, describe, expect, it, vi } from "vitest";
import { preparePackageMutation } from "../package-confirmation";

const h = vi.hoisted(() => ({
  standard: vi.fn(), migrated: vi.fn(), manager: vi.fn(), reload: vi.fn(),
  list: vi.fn(), updates: vi.fn(), remove: vi.fn(),
}));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: h.standard }));
vi.mock("@/lib/session-migrations", () => ({ waitForSessionMigration: h.migrated }));
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
const sdkSession = () => ({ cwd: "/fixture/project", isAlive: () => true,
  inner: { settingsManager: settings }, reloadExtensions: h.reload });
const post = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/packages", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" },
  body: JSON.stringify(body),
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.standard.mockReturnValue(undefined);
  h.migrated.mockImplementation(async (id: string) => id);
  h.list.mockReturnValue([]);
  h.updates.mockResolvedValue([]);
  h.remove.mockResolvedValue(undefined);
  h.reload.mockResolvedValue(undefined);
});

describe("package management SDK sessions", () => {
  it("lists packages using the active SDK settings for a converted session id", async () => {
    h.standard.mockReturnValue(sdkSession());
    const response = await GET(new Request("http://localhost/api/packages?sessionId=dw_active"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ packages: [] });
    expect(h.manager).toHaveBeenCalledWith({ cwd: "/fixture/project", agentDir: "/fixture/agent", settingsManager: settings });
    expect(h.standard).toHaveBeenCalledWith("dw_active");
  });

  it("keeps SDK settings and follows a migrated session URL", async () => {
    h.standard.mockReturnValue({ cwd: "/fixture/project", isAlive: () => true, inner: { settingsManager: settings } });
    expect((await GET(new Request("http://localhost/api/packages?sessionId=legacy"))).status).toBe(200);
    expect(h.standard).toHaveBeenCalledWith("legacy");
    h.migrated.mockResolvedValue("dw_migrated");
    h.standard.mockReturnValue(sdkSession());
    expect((await GET(new Request("http://localhost/api/packages?sessionId=legacy"))).status).toBe(200);
    expect(h.standard).toHaveBeenCalledWith("dw_migrated");
  });

  it("rejects closed or uninitialized SDK sessions", async () => {
    for (const session of [undefined, { ...sdkSession(), isAlive: () => false }, { ...sdkSession(), inner: { settingsManager: undefined } }]) {
      h.standard.mockReturnValue(session);
      expect((await GET(new Request("http://localhost/api/packages?sessionId=dw_inactive"))).status).toBe(409);
    }
    expect(h.manager).not.toHaveBeenCalled();
  });

  it("checks available updates for an active SDK session", async () => {
    h.standard.mockReturnValue(sdkSession());
    expect((await post({ sessionId: "dw_active", action: "check_updates" })).status).toBe(200);
    expect(h.updates).toHaveBeenCalledOnce();
  });

  it("requires confirmation and reloads SDK extensions after a confirmed removal", async () => {
    h.standard.mockReturnValue(sdkSession());
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
