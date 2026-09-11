import { beforeEach, describe, expect, it, vi } from "vitest";

// Every boundary below is mocked. This matrix calls real route handlers, but
// never installs a package, restores files, starts a process, or clears a store.
const mocks = vi.hoisted(() => ({
  packageManager: vi.fn(),
  getRpcSession: vi.fn(),
  runNpx: vi.fn(),
  listAllSessions: vi.fn(),
  getAllowedRoots: vi.fn(),
  inspectSnapshotRestore: vi.fn(),
  restoreSnapshot: vi.fn(),
  createUpdateBackup: vi.fn(),
  executeManagedUpdateAction: vi.fn(),
  findUpdateBackup: vi.fn(),
  getUpdateCenterStatus: vi.fn(),
  collectDiagnosticsBundle: vi.fn(async () => ({ fixture: true })),
  clearSecurityActivity: vi.fn(() => 0),
  recordSecurityActivity: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultPackageManager: mocks.packageManager,
  getAgentDir: () => "/unused-origin-fixture",
}));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: mocks.getRpcSession }));
vi.mock("@/lib/npx", () => ({ runNpx: mocks.runNpx }));
vi.mock("@/lib/session-reader", () => ({ listAllSessions: mocks.listAllSessions }));
vi.mock("@/lib/file-security", () => ({ getAllowedRoots: mocks.getAllowedRoots }));
vi.mock("@/lib/git-snapshot", () => ({
  inspectSnapshotRestore: mocks.inspectSnapshotRestore,
  restoreSnapshot: mocks.restoreSnapshot,
}));
vi.mock("@/lib/update-center", () => ({
  beginManagedUpdateOperation: vi.fn(),
  failReservedUpdateOperation: vi.fn(),
  createUpdateBackup: mocks.createUpdateBackup,
  executeManagedUpdateAction: mocks.executeManagedUpdateAction,
  findUpdateBackup: mocks.findUpdateBackup,
  getUpdateCenterStatus: mocks.getUpdateCenterStatus,
  updateActionFingerprint: vi.fn(),
  validateUpdateAction: vi.fn(),
}));
vi.mock("@/lib/diagnostics", () => ({ collectDiagnosticsBundle: mocks.collectDiagnosticsBundle }));
vi.mock("@/lib/security-activity", () => ({
  clearSecurityActivity: mocks.clearSecurityActivity,
  recordSecurityActivity: mocks.recordSecurityActivity,
  readSecurityActivityStore: vi.fn(),
  SECURITY_ACTIVITY_RETENTION_DAYS: 30,
}));

import { POST as packages } from "../../app/api/packages/route";
import { POST as skills } from "../../app/api/skills/install/route";
import { POST as update } from "../../app/api/runtime/update/route";
import { POST as restore } from "../../app/api/git/snapshots/restore/route";
import { POST as diagnostics } from "../../app/api/diagnostics/route";
import { DELETE as security } from "../../app/api/security/activity/route";

const STOP_AFTER_ORIGIN = "Origin accepted; fixture stopped before action";
const routes = [
  { path: "/api/packages", handler: packages, body: true },
  { path: "/api/skills/install", handler: skills, body: true },
  { path: "/api/runtime/update", handler: update, body: true },
  { path: "/api/git/snapshots/restore", handler: restore, body: true },
  { path: "/api/diagnostics", handler: diagnostics, body: false },
  { path: "/api/security/activity", handler: security, body: false },
];

type OriginCase = { name: string; headers: Record<string, string | undefined> };
const allowed: OriginCase[] = [
  { name: "localhost", headers: {} },
  { name: "127.0.0.1 Host despite internal localhost", headers: { origin: "http://127.0.0.1:30178", host: "127.0.0.1:30178" } },
  { name: "reverse-proxied HTTPS", headers: { origin: "https://pi.example.test", host: "127.0.0.1:30178", "x-forwarded-host": "pi.example.test", "x-forwarded-proto": "https" } },
  { name: "explicit Origin without optional Fetch Metadata", headers: { "sec-fetch-site": undefined } },
];
const denied: OriginCase[] = [
  { name: "missing Origin", headers: { origin: undefined } },
  { name: "opaque Origin", headers: { origin: "null" } },
  { name: "malformed Origin", headers: { origin: "not a URL" } },
  { name: "cross-site", headers: { "sec-fetch-site": "cross-site" } },
  { name: "same-site but not same-origin", headers: { "sec-fetch-site": "same-site" } },
  { name: "non-browser navigation metadata", headers: { "sec-fetch-site": "none" } },
  { name: "different host", headers: { origin: "http://other.test:30178" } },
  { name: "different port", headers: { origin: "http://localhost:30179" } },
  { name: "different protocol", headers: { origin: "https://localhost:30178" } },
  { name: "raw URL matches but actual Host does not", headers: { host: "127.0.0.1:30178" } },
  { name: "raw URL matches but forwarded host does not", headers: { "x-forwarded-host": "pi.example.test" } },
  { name: "raw URL matches but forwarded protocol does not", headers: { "x-forwarded-proto": "https" } },
  { name: "proxy host matches but protocol differs", headers: { origin: "http://pi.example.test", "x-forwarded-host": "pi.example.test", "x-forwarded-proto": "https" } },
  { name: "proxy host matches but port differs", headers: { origin: "https://pi.example.test:8443", "x-forwarded-host": "pi.example.test", "x-forwarded-proto": "https" } },
  { name: "matching forwarded headers cannot override cross-site metadata", headers: { origin: "https://pi.example.test", "x-forwarded-host": "pi.example.test", "x-forwarded-proto": "https", "sec-fetch-site": "cross-site" } },
  { name: "matching forwarded headers cannot replace explicit Origin", headers: { origin: undefined, "x-forwarded-host": "pi.example.test", "x-forwarded-proto": "https" } },
];

function request(route: typeof routes[number], changes: OriginCase["headers"] = {}) {
  const headers = new Headers({
    origin: "http://localhost:30178",
    host: "localhost:30178",
    "sec-fetch-site": "same-origin",
    "x-pi-diagnostics-consent": "export",
  });
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) headers.delete(name);
    else headers.set(name, value);
  }
  const req = new Request(`http://localhost:30178${route.path}`, {
    method: route.path === "/api/security/activity" ? "DELETE" : "POST",
    headers,
  });
  // Stop body-based actions immediately after the real origin guard. This is
  // stronger than an invalid action fixture: no downstream code is entered.
  const json = vi.spyOn(req, "json").mockRejectedValue(new Error(STOP_AFTER_ORIGIN));
  return { req, json };
}

beforeEach(() => vi.clearAllMocks());

describe.each(routes)("sensitive origin boundary: $path", (route) => {
  it.each(allowed)("allows $name without real mutations", async ({ headers }) => {
    const { req, json } = request(route, headers);
    const response = await route.handler(req);
    const payload = await response.json();
    if (route.body) {
      expect(json).toHaveBeenCalledOnce();
      expect(payload.error).toBe(STOP_AFTER_ORIGIN);
    } else {
      expect(response.status).toBe(200);
      if (route.path === "/api/diagnostics") expect(payload).toEqual({ fixture: true });
      else expect(payload).toEqual({ ok: true, cleared: 0 });
    }
    for (const [name, mock] of Object.entries(mocks)) {
      if (["collectDiagnosticsBundle", "clearSecurityActivity", "recordSecurityActivity"].includes(name)) continue;
      expect(mock, `${name} must remain untouched`).not.toHaveBeenCalled();
    }
  });

  it.each(denied)("rejects $name before any action", async ({ headers }) => {
    const { req, json } = request(route, headers);
    const response = await route.handler(req);
    expect(response.status).toBe(403);
    expect(json).not.toHaveBeenCalled();
    for (const [name, mock] of Object.entries(mocks)) {
      // Rejected requests may be audited, but never reach the requested action.
      if (name === "recordSecurityActivity") continue;
      expect(mock, `${name} must remain untouched`).not.toHaveBeenCalled();
    }
  });
});

it("still requires diagnostics export consent after the origin passes", async () => {
  const { req } = request(routes[4], { "x-pi-diagnostics-consent": undefined });
  expect((await diagnostics(req)).status).toBe(403);
  expect(mocks.collectDiagnosticsBundle).not.toHaveBeenCalled();
});
