import { describe, expect, it } from "vitest";
import { normalizeQueuedFollowUps, moveQueuedFollowUp } from "../queued-follow-ups";
describe("queue event compatibility", () => {
  it("keeps duplicate occurrences distinct through replay and consumption", () => {
    const first = normalizeQueuedFollowUps({ steering: ["interrupt"], followUp: ["repeat", "repeat"] });
    const replay = normalizeQueuedFollowUps({ steering: ["interrupt"], followUp: ["repeat", "repeat"] }, first);
    expect(replay).toEqual(first);
    expect(new Set(first.map(item => item.id)).size).toBe(3);
    const consumed = normalizeQueuedFollowUps({ steering: [], followUp: ["repeat"] }, replay);
    expect(consumed).toEqual([first[2]]);
    expect(moveQueuedFollowUp(first, first[1].id, -1)).toBe(first);
  });
  it("validates structured queue items and ignores malformed frames without dropping existing work", () => {
    const previous = [{ id: "a", message: "queued", images: [{ data: "data", mimeType: "image/png" }] }];
    expect(normalizeQueuedFollowUps({ items: [{ id: "a", message: "edited" }, null, 3] }, previous)).toMatchObject([{ id: "a", message: "edited", images: previous[0].images }]);
    expect(normalizeQueuedFollowUps({}, previous)).toBe(previous);
    expect(normalizeQueuedFollowUps({ items: [] }, previous)).toEqual([]);
  });
});
