import { beforeEach, describe, expect, it, vi } from "vitest";
const generate = vi.hoisted(() => vi.fn());
vi.mock("../composer-hint-service", () => ({ generateComposerHint: generate }));
import { POST } from "../../app/api/composer-hint/route";

const body = { provider: "fixture", modelId: "one", locale: "en", messages: [
  { role: "user", text: "Fix the preview" }, { role: "assistant", text: "Fixed. Test mobile next." },
] };
const send = (payload: unknown = body, origin = "http://localhost") => POST(new Request("http://localhost/api/composer-hint", {
  method: "POST", headers: { origin, "content-type": "application/json" }, body: typeof payload === "string" ? payload : JSON.stringify(payload),
}));
beforeEach(() => { generate.mockReset(); generate.mockResolvedValue("Test the preview on mobile"); });
describe("composer hint HTTP endpoint", () => {
  it("returns a private uncached suggestion without altering a conversation", async () => {
    const response = await send();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ hint: "Test the preview on mobile" });
    expect(generate).toHaveBeenCalledWith(body, expect.any(AbortSignal));
  });
  it("rejects cross-origin requests and invalid or oversized context before model use", async () => {
    expect((await send(body, "https://other.test")).status).toBe(403);
    expect((await send("not-json-private-value")).status).toBe(400);
    expect((await send({ ...body, messages: [] })).status).toBe(400);
    const oversized = await send(" ".repeat(24_001));
    expect(oversized.status).toBe(413);
    expect(generate).not.toHaveBeenCalled();
  });
  it("keeps provider failures out of the UI", async () => {
    generate.mockResolvedValue(null);
    expect(await (await send()).json()).toEqual({ hint: null });
  });
});
