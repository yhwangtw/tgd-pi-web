import * as fs from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { GET, PUT } from "../../app/api/models-config/route";

const config = { providers: { fixture: { apiKey: "private-fixture-key", models: [{ id: "one" }] } } };
const filename = () => join(getAgentDir(), "models.json");
const put = (body: unknown, revision?: string) => PUT(new Request("http://localhost/api/models-config", {
  method: "PUT", headers: { "content-type": "application/json", origin: "http://localhost", ...(revision ? { "if-match": revision } : {}) }, body: JSON.stringify(body),
}));
beforeEach(async () => { await fs.rm(filename(), { force: true }); });
describe("models configuration HTTP contract", () => {
  it("preserves raw GET consumers and exposes revision and effective path separately", async () => {
    const initial = await GET();
    expect(await initial.json()).toEqual({ providers: {} });
    expect(initial.headers.get("etag")).toBe('"missing"');
    expect(decodeURIComponent(initial.headers.get("x-models-config-path")!)).toBe(filename());
    expect(initial.headers.get("cache-control")).toContain("no-store");
    expect((await put(config)).status).toBe(428);
    const saved = await put(config, initial.headers.get("etag")!);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("etag")).not.toBe(initial.headers.get("etag"));
    expect((await put(config, initial.headers.get("etag")!)).status).toBe(409);
    expect(await (await GET()).json()).toEqual(config);
  });
  it("does not echo malformed secret-bearing contents or replace them with empty config", async () => {
    await fs.writeFile(filename(), "private-fixture-key not-json");
    const read = await GET();
    expect(read.status).toBe(503);
    expect(decodeURIComponent(read.headers.get("x-models-config-path")!)).toBe(filename());
    expect(await read.text()).not.toContain("private-fixture-key");
    const save = await put(config, '"missing"');
    expect(save.status).toBe(503);
    expect(await save.text()).not.toContain("private-fixture-key");
    expect(await fs.readFile(filename(), "utf8")).toBe("private-fixture-key not-json");
  });
  it("rejects cross-origin mutations before any write", async () => {
    const response = await PUT(new Request("http://localhost/api/models-config", { method: "PUT", headers: { origin: "https://other.test", "if-match": '"missing"' }, body: JSON.stringify(config) }));
    expect(response.status).toBe(403);
    await expect(fs.stat(filename())).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(['*', 'W/"missing"', '"missing", "other"'])("rejects unsafe If-Match %s", async revision => {
    expect((await put(config, revision)).status).toBe(400);
    await expect(fs.stat(filename())).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("bounds the request body and never includes malformed text in errors", async () => {
    for (const [body, status] of [[" ".repeat(4 * 1024 * 1024 + 1), 413], ["private-fixture-key not-json", 400]] as const) {
      const response = await PUT(new Request("http://localhost/api/models-config", { method: "PUT", headers: { origin: "http://localhost", "if-match": '"missing"' }, body }));
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("private-fixture-key");
    }
    await expect(fs.stat(filename())).rejects.toMatchObject({ code: "ENOENT" });
  });
});
