import { describe, expect, it } from "vitest";
import { gunzipSync, gzipSync } from "node:zlib";
import { createSessionJsonResponder, sessionJsonResponse } from "../session-json-response";

const large = { messages: [{ role: "assistant", content: "繁體中文與 code ".repeat(4000) }], leafId: "kept" };
const request = (encoding?: string) => new Request("http://localhost/session", { headers: encoding ? { "Accept-Encoding": encoding } : {} });
describe("session JSON transport", () => {
  it("compresses large negotiated bodies without changing any Unicode, history or branch field", async () => {
    const response = await sessionJsonResponse(request("gzip, deflate, br"), large, true);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toBe("X-Pi-Session-Tree, Accept-Encoding");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(Buffer.byteLength(JSON.stringify(large)) / 4);
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(JSON.parse(gunzipSync(bytes).toString("utf8"))).toEqual(large);
  });
  it.each([undefined, "br", "identity", "gzip;q=0", "gzip;q=0, *;q=1", "gzip;q=bad", "gzip;q=1.5"])("preserves plain JSON when gzip is not accepted: %s", async encoding => {
    const response = await sessionJsonResponse(request(encoding), large);
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(await response.json()).toEqual(large);
  });
  it.each(["gzip;q=0.5", "*;q=0.5", "GZip; q=1.000"])("accepts a valid negotiated quality: %s", async encoding => {
    expect((await sessionJsonResponse(request(encoding), large)).headers.get("content-encoding")).toBe("gzip");
  });
  it("does not compress tiny responses", async () => {
    const response = await sessionJsonResponse(request("gzip"), { messages: [] });
    expect(response.headers.has("content-encoding")).toBe(false); expect(await response.json()).toEqual({ messages: [] });
  });
  it("reuses compression only for byte-identical authorized responses, including settings and branch changes", async () => {
    let calls = 0;
    const respond = createSessionJsonResponder({ compressor: async body => { calls++; return gzipSync(body); } });
    const body = { ...large, state: { model: "first", running: false } };
    const a = await respond(request("gzip"), body);
    const aBytes = new Uint8Array(await a.arrayBuffer()); aBytes.fill(0);
    const b = await respond(request("gzip"), body);
    expect(JSON.parse(gunzipSync(new Uint8Array(await b.arrayBuffer())).toString())).toEqual(body);
    expect(calls).toBe(1);
    for (const changed of [{ ...body, leafId: "other branch" }, { ...body, state: { model: "second", running: false } }, { ...body, state: { model: "first", running: true } }]) {
      const response = await respond(request("gzip"), changed);
      expect(JSON.parse(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString())).toEqual(changed);
    }
    expect(calls).toBe(4);
  });
  it("shares in-flight compression, evicts old bodies and never retains oversized compressed results", async () => {
    let calls = 0;
    let release = () => {};
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const respond = createSessionJsonResponder({ maxEntries: 1, compressor: async body => { calls++; await barrier; return gzipSync(body); } });
    const responses = [respond(request("gzip"), large), respond(request("gzip"), large)];
    await Promise.resolve(); expect(calls).toBe(1); release(); await Promise.all(responses);
    await respond(request("gzip"), { ...large, leafId: "changed" });
    await respond(request("gzip"), large); expect(calls).toBe(3);
    const tinyCache = createSessionJsonResponder({ maxBytes: 1, compressor: async body => { calls++; return gzipSync(body); } });
    await tinyCache(request("gzip"), large); await tinyCache(request("gzip"), large); expect(calls).toBe(5);
  });

  it("accounts once for identical results beyond the bounded in-flight map", async () => {
    const values = Array.from({ length: 5 }, (_, index) => ({ ...large, leafId: `branch-${index}` }));
    const maxBytes = values.reduce((sum, value) => sum + gzipSync(Buffer.from(JSON.stringify(value))).byteLength, 0);
    let release = () => {}; let calls = 0;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const respond = createSessionJsonResponder({ maxEntries: 5, maxBytes, compressor: async body => { calls++; await barrier; return gzipSync(body); } });
    const work = values.map(value => respond(request("gzip"), value));
    work.push(respond(request("gzip"), values[4]));
    await Promise.resolve(); expect(calls).toBe(6); release(); await Promise.all(work);
    for (const value of values) await respond(request("gzip"), value);
    expect(calls).toBe(6);
  });

});
