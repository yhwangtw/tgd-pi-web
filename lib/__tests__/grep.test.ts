import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { grepWithJs, parseRgJson } from "../grep";

describe("grepWithJs", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "grep-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "a.ts"), "export const answer = 42;\nconst other = 1;\n");
    writeFileSync(path.join(root, "src", "b.ts"), "// no match here\nconst answer2 = answer + 1;\n");
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "const answer = 999;\n");
    // A binary-ish file with a NUL byte — must be skipped.
    writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x61, 0x00, 0x61, 0x6e, 0x73, 0x77, 0x65, 0x72]));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("finds matches with line + column", async () => {
    const matches = await grepWithJs(root, "answer", { caseSensitive: false, maxResults: 100 });
    const rels = matches.map((m) => `${m.relative}:${m.line}`);
    expect(rels).toContain(path.join("src", "a.ts") + ":1");
    expect(rels).toContain(path.join("src", "b.ts") + ":2");
    const a = matches.find((m) => m.relative.endsWith("a.ts"))!;
    expect(a.col).toBe("export const ".length + 1); // 1-based col of "answer"
    expect(a.text).toBe("export const answer = 42;");
  });

  it("skips node_modules and binary files", async () => {
    const matches = await grepWithJs(root, "answer", { caseSensitive: false, maxResults: 100 });
    expect(matches.some((m) => m.relative.includes("node_modules"))).toBe(false);
    expect(matches.some((m) => m.relative.includes("bin.dat"))).toBe(false);
  });

  it("honors case sensitivity", async () => {
    writeFileSync(path.join(root, "src", "c.ts"), "const ANSWER = 1;\n");
    expect((await grepWithJs(root, "ANSWER", { caseSensitive: true, maxResults: 100 })).length).toBe(1);
    expect((await grepWithJs(root, "ANSWER", { caseSensitive: false, maxResults: 100 })).length).toBeGreaterThan(1);
  });

  it("respects maxResults", async () => {
    expect((await grepWithJs(root, "answer", { caseSensitive: false, maxResults: 1 })).length).toBe(1);
  });
});

describe("parseRgJson", () => {
  it("extracts matches from rg --json stream, ignoring non-match events", () => {
    const root = "/proj";
    const stream = [
      JSON.stringify({ type: "begin", data: { path: { text: "/proj/src/a.ts" } } }),
      JSON.stringify({ type: "match", data: {
        path: { text: "/proj/src/a.ts" },
        lines: { text: "const answer = 42;\n" },
        line_number: 1,
        submatches: [{ start: 6 }],
      } }),
      JSON.stringify({ type: "end", data: {} }),
      "",
    ].join("\n");
    const matches = parseRgJson(stream, root, 100);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ relative: "src/a.ts", line: 1, col: 7, text: "const answer = 42;" });
  });
});
