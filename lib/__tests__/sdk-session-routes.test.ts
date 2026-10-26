import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const runtime = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: runtime.get }));
import { GET as detail, PATCH as rename } from "../../app/api/sessions/[id]/route";
import { GET as context } from "../../app/api/sessions/[id]/context/route";
import { GET as markdown } from "../../app/api/sessions/[id]/export-md/route";
import { POST as clone } from "../../app/api/sessions/[id]/clone/route";
import { GET as search } from "../../app/api/sessions/search/route";
import { GET as analytics } from "../../app/api/sessions/analytics/route";
import { GET as semantic } from "../../app/api/search/semantic/route";
import { migrationDirectory, migrationKey } from "../session-migrations";

const id = "dw_00000000-0000-0000-0000-000000000000_1";
const timestamp = "2026-10-22T00:00:00.000Z";
const params = (sessionId = id) => ({ params: Promise.resolve({ id: sessionId }) });
const sourcePath = () => join(getAgentDir(), "sessions", "--fixture", `${id}.jsonl`);
const fixture = () => [
  { type: "session", version: 3, id, cwd: "/fixture", timestamp },
  { type: "model_change", id: "model", parentId: null, timestamp, provider: "fixture", modelId: "offline" },
  { type: "message", id: "user", parentId: "model", timestamp, message: { role: "user", content: "Converted searchable question", timestamp: 1 } },
  { type: "message", id: "answer", parentId: "user", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Preserved answer" }], provider: "fixture", model: "offline", timestamp: 2 } },
  { type: "custom", id: "extension", parentId: "answer", timestamp, customType: "fixture-extension", data: { preserved: true } },
  { type: "session_info", id: "name", parentId: "extension", timestamp, name: "Converted history" },
];

beforeEach(() => {
  runtime.get.mockReset();
  rmSync(join(getAgentDir(), "sessions"), { recursive: true, force: true });
  rmSync(migrationDirectory(), { recursive: true, force: true });
  mkdirSync(join(getAgentDir(), "sessions", "--fixture"), { recursive: true });
  writeFileSync(sourcePath(), fixture().map(entry => JSON.stringify(entry)).join("\n") + "\n");
  globalThis.__piSessionInfoCache = undefined;
  globalThis.__piSessionPathCache = undefined;
  globalThis.__piSessionListings = undefined;
});

describe("SDK APIs for converted session IDs", () => {
  it("reads the SDK tree, context, exports and search without changing the source", async () => {
    const before = readFileSync(sourcePath(), "utf8");
    const response = await detail(new Request("http://localhost/?includeState"), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessionId).toBe(id);
    expect(body.info).toMatchObject({ id, name: "Converted history", cwd: "/fixture" });
    expect(body.context.messages).toHaveLength(2);
    expect(body.tree[0].children[0].children[0].children[0].entry.customType).toBe("fixture-extension");
    expect((await (await context(new Request("http://localhost/?leafId=user"), params())).json()).context.messages).toHaveLength(1);
    expect(await (await markdown(new Request("http://localhost/"), params())).text()).toContain("Preserved answer");
    const matches = await (await search(new Request("http://localhost/?q=searchable"))).json();
    expect(matches.hits).toEqual([expect.objectContaining({ id, provider: "fixture", modelId: "offline" })]);
    const semanticMatches = await (await semantic(new Request("http://localhost/?q=searchable"))).json();
    expect(semanticMatches.hits).toEqual([expect.objectContaining({ sessionId: id })]);
    const report = await (await analytics()).json();
    expect(report.summary).toMatchObject({ sessionCount: 1, totalMessages: 2 });
    expect(report.perSession[0].id).toBe(id);
    expect(readFileSync(sourcePath(), "utf8")).toBe(before);
  });

  it("resolves old bookmarks to the SDK file and preserves the converted ID", async () => {
    mkdirSync(migrationDirectory(), { recursive: true });
    const source = readFileSync(sourcePath(), "utf8");
    writeFileSync(join(migrationDirectory(), `${migrationKey("old-bookmark")}.json`), JSON.stringify({ version: 1, sourceId: "old-bookmark", sessionId: id, sourcePath: sourcePath(), sourceHash: createHash("sha256").update(source).digest("hex"), migratedAt: timestamp }));
    const response = await detail(new Request("http://localhost/"), params("old-bookmark"));
    expect(response.status).toBe(200);
    expect((await response.json()).sessionId).toBe(id);
    expect(readFileSync(sourcePath(), "utf8")).toBe(source);
  });

  it("renames and clones the SDK history while keeping the source ID and extension entry", async () => {
    const renamed = await rename(new Request("http://localhost/", { method: "PATCH", body: JSON.stringify({ name: "Renamed SDK history" }) }), params());
    expect(renamed.status).toBe(200);
    const source = readFileSync(sourcePath(), "utf8");
    expect(JSON.parse(source.split("\n")[0]).id).toBe(id);
    const response = await clone(new Request("http://localhost/", { method: "POST" }), params());
    expect(response.status).toBe(201);
    const cloned = await response.json();
    expect(cloned.sessionId).not.toBe(id);
    expect(cloned.cwd).toBe("/fixture");
    expect(readFileSync(cloned.sessionFile, "utf8")).toContain('"customType":"fixture-extension"');
    expect(readFileSync(sourcePath(), "utf8")).toBe(source);
  });
});
