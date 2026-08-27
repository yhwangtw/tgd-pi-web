import { describe, it, expect } from "vitest";
import { buildSessionTree, getSessionDisplayTitle, getSessionProjectName } from "../session-utils";
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

describe("getSessionProjectName", () => {
  it("uses the final directory for Unix and Windows session paths", () => {
    expect(getSessionProjectName("/Users/elon/dev/tGD-pi-web")).toBe("tGD-pi-web");
    expect(getSessionProjectName("C:\\Users\\elon\\demo-project")).toBe("demo-project");
  });
});
