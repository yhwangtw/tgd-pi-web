import { describe, expect, it } from "vitest";
import { isFixtureReadReceipt } from "../../e2e/read-receipt-fixture";

const origin = "http://localhost:30177";
const validBody = { scope: "fixture-scope", receipts: [{ id: "session_1", entryId: "entry-1" }] };
const headers = { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
function request(body: unknown = validBody, overrides: { method?: string; url?: string; headers?: Record<string, string>; raw?: string | null } = {}) {
  return {
    method: () => overrides.method ?? "POST", url: () => overrides.url ?? `${origin}/api/sessions/reads`,
    headers: () => overrides.headers ?? headers, postData: () => overrides.raw === undefined ? JSON.stringify(body) : overrides.raw,
  };
}
describe("offline E2E read-receipt allowance", () => {
  it("allows only the existing scoped browser request, including the 32-item bound", () => {
    expect(isFixtureReadReceipt(request())).toBe(true);
    expect(isFixtureReadReceipt(request({ ...validBody, receipts: Array.from({ length: 32 }, (_, i) => ({ id: `session-${i}`, entryId: `entry-${i}` })) }))).toBe(true);
  });
  it.each([
    ["GET", { method: "GET" }], ["DELETE", { method: "DELETE" }],
    ["agent prompt", { url: `${origin}/api/agent/new` }], ["another mutation", { url: `${origin}/api/sessions/session_1` }],
    ["query-shaped action", { url: `${origin}/api/sessions/reads?action=delete` }],
    ["external target", { url: "http://example.com/api/sessions/reads", headers: { ...headers, origin: "http://example.com" } }],
    ["wrong origin", { headers: { ...headers, origin: "http://localhost:30178" } }],
    ["missing origin", { headers: { "content-type": "application/json" } }],
    ["cross-site metadata", { headers: { ...headers, "sec-fetch-site": "cross-site" } }],
    ["non-JSON body", { headers: { ...headers, "content-type": "text/plain" } }],
    ["missing body", { raw: null }], ["invalid JSON", { raw: "{" }],
    ["oversized JSON", { raw: `${JSON.stringify(validBody)}${" ".repeat(32_768)}` }],
  ] as const)("keeps %s requests blocked", (_name, overrides) => {
    expect(isFixtureReadReceipt(request(validBody, overrides))).toBe(false);
  });
  it.each([
    null, [], {}, { ...validBody, scope: "" }, { ...validBody, scope: 42 }, { ...validBody, scope: "x".repeat(257) },
    { ...validBody, receipts: [] }, { ...validBody, receipts: Array(33).fill(validBody.receipts[0]) },
    { ...validBody, receipts: [null] }, { ...validBody, receipts: [{ id: "../escape", entryId: "entry" }] },
    { ...validBody, receipts: [{ id: "x".repeat(257), entryId: "entry" }] },
    { ...validBody, receipts: [{ id: "session", entryId: "" }] },
    { ...validBody, receipts: [{ id: "session", entryId: "x".repeat(257) }] },
    { ...validBody, type: "prompt" }, { ...validBody, receipts: [{ ...validBody.receipts[0], type: "prompt" }] },
  ].map(body => ({ body })))("rejects malformed or action-shaped payload %j", ({ body }) => {
    expect(isFixtureReadReceipt(request(body))).toBe(false);
  });
});
