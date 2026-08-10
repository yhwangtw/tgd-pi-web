import { describe, expect, it } from "vitest";
import { buildFileAgentPrompt, extractFileOutline, hexPreview, parseDelimitedText, selectionFromOffsets } from "../file-workbench";

describe("file workbench helpers", () => {
  it("extracts markdown and TypeScript structure", () => {
    expect(extractFileOutline("# Title\n## Child", "markdown").map((item) => [item.label, item.level])).toEqual([["Title", 1], ["Child", 2]]);
    expect(extractFileOutline("export class A {}\nexport function run() {}\nconst Card = () => null", "typescript").map((item) => item.kind)).toEqual(["class", "function", "component"]);
  });

  it("parses quoted CSV and TSV", () => {
    expect(parseDelimitedText('name,note\nA,"x,y"', ",")).toEqual([["name", "note"], ["A", "x,y"]]);
    expect(parseDelimitedText("a\tb\n1\t2", "\t")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("maps a text selection to line numbers and a prompt", () => {
    const selection = selectionFromOffsets("one\ntwo\nthree", 4, 7);
    expect(selection).toEqual({ startLine: 2, endLine: 2, text: "two" });
    expect(buildFileAgentPrompt("review", "src/a.ts", selection)).toContain("src/a.ts:2");
  });

  it("renders a compact hex preview", () => {
    expect(hexPreview(new Uint8Array([65, 0, 66]))[0]).toContain("41 00 42");
    expect(hexPreview(new Uint8Array([65, 0, 66]))[0]).toContain("|A.B|");
  });
});
