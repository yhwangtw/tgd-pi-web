import { describe, expect, it } from "vitest";
import { rankSemanticDocuments } from "../semantic-search";

describe("semantic search", () => {
  it("expands related concepts and boosts titles", () => {
    const hits = rankSemanticDocuments("部署失敗", [
      { id: "1", source: "session", title: "Production release error", text: "The deploy job failed after publish." },
      { id: "2", source: "code", title: "unrelated", text: "button colors" },
    ]);
    expect(hits[0]?.id).toBe("1");
    expect(hits).toHaveLength(1);
  });
});
