import { describe, expect, it } from "vitest";
import { parseCommitLog, renderReleaseNotes } from "../release-notes.mjs";
const metadata = { version: "v2026.10.23-3", sourceSha: "a".repeat(40), ciSha: "b".repeat(40), ciUrl: "https://example.test/ci" };
describe("release note subjects", () => {
  it("parses delimiter-like text and backslashes without interpreting them", () => {
    const subject = String.raw`fix(scope): preserve |||, C:\new, \c, \n and 中文`;
    const commits = parseCommitLog(`abc1234\0${subject}\0def5678\0feat!: final entry\0`);
    expect(commits).toEqual([{ hash: "abc1234", subject }, { hash: "def5678", subject: "feat!: final entry" }]);
    const notes = renderReleaseNotes(commits, metadata);
    expect(notes).toContain("### 🐛 Bug Fixes");
    expect(notes).toContain(String.raw`C:\\new, \\c, \\n and 中文`);
    expect(notes).toContain("- final entry (`def5678`)");
  });
  it("rejects truncated fields and escapes Markdown in commit subjects", () => {
    expect(() => parseCommitLog("abc1234\0missing terminator\0dangling")).toThrow();
    expect(() => parseCommitLog("invalid\0subject\0")).toThrow();
    expect(renderReleaseNotes([{ hash: "abc1234", subject: "fix: <tag> [link] *bold* `code`" }], metadata)).toContain(String.raw`\<tag\> \[link\] \*bold\* \`code\``);
  });
});
