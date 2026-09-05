import { describe, it, expect } from "vitest";
import { buildSessionDisplayTitles, buildSessionTree, findSessionTreeNode, flattenSessionTree, getSessionDisplayTitle, getSessionPreview, getSessionProjectName } from "../session-utils";
import type { SessionInfo } from "@/lib/types";

const s = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  path: `/tmp/${id}.jsonl`,
  id,
  cwd: "/proj",
  created: "2026-07-01T00:00:00Z",
  modified: "2026-07-01T00:00:00Z",
  messageCount: 1,
  firstMessage: `msg-${id}`,
  ...over,
});

describe("buildSessionTree sort modes", () => {
  const sessions: SessionInfo[] = [
    s("a", { name: "zeta", modified: "2026-07-03T00:00:00Z", messageCount: 2 }),
    s("b", { name: "alpha", modified: "2026-07-01T00:00:00Z", messageCount: 9 }),
    s("c", { name: "Midway", modified: "2026-07-02T00:00:00Z", messageCount: 5 }),
  ];
  const ids = (nodes: ReturnType<typeof buildSessionTree>) => nodes.map((n) => n.session.id);

  it("defaults to recency (modified desc)", () => {
    expect(ids(buildSessionTree(sessions))).toEqual(["a", "c", "b"]);
  });

  it("name mode sorts case-insensitively by title", () => {
    expect(ids(buildSessionTree(sessions, "name"))).toEqual(["b", "c", "a"]);
  });

  it("name mode falls back to firstMessage when unnamed", () => {
    const unnamed = [
      s("x", { name: undefined, firstMessage: "banana" }),
      s("y", { name: undefined, firstMessage: "apple" }),
    ];
    expect(ids(buildSessionTree(unnamed, "name"))).toEqual(["y", "x"]);
  });

  it("messages mode sorts by count desc, recency as tiebreak", () => {
    const tied = [...sessions, s("d", { messageCount: 5, modified: "2026-07-04T00:00:00Z" })];
    expect(ids(buildSessionTree(tied, "messages"))).toEqual(["b", "d", "c", "a"]);
  });

  it("fork children stay in recency order regardless of root mode", () => {
    const withForks = [
      s("root", { name: "root", modified: "2026-07-01T00:00:00Z" }),
      s("f1", { name: "aaa", parentSessionId: "root", modified: "2026-07-02T00:00:00Z" }),
      s("f2", { name: "zzz", parentSessionId: "root", modified: "2026-07-03T00:00:00Z" }),
    ];
    const tree = buildSessionTree(withForks, "name");
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.session.id)).toEqual(["f2", "f1"]);
  });
});

describe("windowed tree helpers", () => {
  const tree = buildSessionTree([
    s("root"),
    s("fork", { parentSessionId: "root" }),
    s("leaf", { parentSessionId: "fork" }),
    s("other"),
  ]);

  it("finds pinned forks below the root level", () => {
    expect(findSessionTreeNode(tree, "fork")?.session.id).toBe("fork");
  });

  it("flattens visible forks and promotes descendants of an excluded pin", () => {
    expect(flattenSessionTree(tree).map(({ node, depth }) => [node.session.id, depth])).toEqual([
      ["root", 0], ["fork", 1], ["leaf", 2], ["other", 0],
    ]);
    expect(flattenSessionTree(tree, new Set(), new Set(["fork"])).map(({ node, depth }) => [node.session.id, depth])).toEqual([
      ["root", 0], ["leaf", 1], ["other", 0],
    ]);
    expect(flattenSessionTree(tree, new Set(["root"])).map(({ node }) => node.session.id)).toEqual(["root", "other"]);
  });
});

describe("getSessionDisplayTitle", () => {
  it("prefers a custom name, then the first message, without exposing the id", () => {
    expect(getSessionDisplayTitle(s("secret-id", { name: "Release polish", firstMessage: "fallback" }))).toBe("Release polish");
    expect(getSessionDisplayTitle(s("secret-id", { name: undefined, firstMessage: "Fix the mobile layout" }))).toBe("Fix the mobile layout");
    expect(getSessionDisplayTitle(s("secret-id", { name: undefined, firstMessage: "" }))).toBe("Untitled session");
  });

  it("truncates long titles with an ellipsis", () => {
    expect(getSessionDisplayTitle(s("x", { firstMessage: "123456789" }), 6)).toBe("12345…");
  });
});

describe("conversation list labels", () => {
  it("disambiguates duplicate titles by repo and then activity date", () => {
    const titles = buildSessionDisplayTitles([
      s("a", { name: "Fix layout", cwd: "/work/alpha", modified: "2026-07-03T00:00:00Z" }),
      s("b", { name: "Fix layout", cwd: "/work/beta", modified: "2026-07-02T00:00:00Z" }),
      s("c", { name: "Fix layout", cwd: "/other/beta", modified: "2026-07-01T00:00:00Z" }),
    ]);
    expect(titles.get("a")).toBe("Fix layout · alpha");
    expect(titles.get("b")).toBe("Fix layout · beta · 2026-07-02");
    expect(titles.get("c")).toBe("Fix layout · beta · 2026-07-01");
  });

  it("keeps same-project same-day duplicate titles unique", () => {
    const titles = buildSessionDisplayTitles([
      s("abcdef-one", { name: "Fix layout", cwd: "/work/alpha", modified: "2026-07-03T09:15:00Z" }),
      s("abcdef-two", { name: "Fix layout", cwd: "/work/alpha", modified: "2026-07-03T10:30:00Z" }),
      s("unique-id", { name: "Fix layout", cwd: "/work/alpha", modified: "2026-07-03T10:30:30Z" }),
    ]);
    expect(titles.get("abcdef-one")).toBe("Fix layout · alpha · 2026-07-03 09:15");
    expect(titles.get("abcdef-two")).toBe("Fix layout · alpha · 2026-07-03 10:30 · deftwo");
    expect(titles.get("unique-id")).toBe("Fix layout · alpha · 2026-07-03 10:30 · iqueid");
    expect(new Set(titles.values()).size).toBe(3);
  });

  it("shows a last-message preview only when it adds information", () => {
    expect(getSessionPreview(s("a", { firstMessage: "Start", lastMessage: "Done" }))).toBe("Done");
    expect(getSessionPreview(s("b", { firstMessage: "Same", lastMessage: "Same" }))).toBe("");
  });

  it("turns Markdown into a compact, plain-language excerpt", () => {
    expect(getSessionPreview(s("a", { lastMessage: "## 結果\n- **完成** [檔案](https://example.com/readme) `src/test_file.ts`\n```ts\nconst value = 1;\n```" })))
      .toBe("結果 完成 檔案 src/test_file.ts const value = 1;");
    expect(getSessionPreview(s("b", { firstMessage: "完成", lastMessage: "**完成**" }))).toBe("");
    expect(getSessionPreview(s("c", { lastMessage: "text ".repeat(1000) })).length).toBeLessThanOrEqual(240);
    expect(getSessionPreview(s("d", { lastMessage: "a < b and src/test_file.ts" }))).toBe("a < b and src/test_file.ts");
    expect(getSessionPreview(s("e", { lastMessage: "> [!RESULT] 完成\n> - URL: <https://example.com>\n> - **正常**" }))).toBe("完成 URL: https://example.com 正常");
  });
});

describe("getSessionProjectName", () => {
  it("uses the final directory for Unix and Windows session paths", () => {
    expect(getSessionProjectName("/Users/elon/dev/tGD-pi-web")).toBe("tGD-pi-web");
    expect(getSessionProjectName("C:\\Users\\elon\\demo-project")).toBe("demo-project");
  });
});
