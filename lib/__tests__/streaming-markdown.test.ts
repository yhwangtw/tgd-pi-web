import { describe, expect, it } from "vitest";
import { splitStreamingMarkdown } from "../streaming-markdown";

describe("conservative streaming Markdown boundaries", () => {
  it("keeps complete source text and only splits at independent blank-line blocks", () => {
    const markdown = "\n# Heading\n\nA **bold** paragraph.\n\n\nNext\nline.\n\n  ";
    const chunks = splitStreamingMarkdown(markdown)!;
    expect(chunks).toEqual(["\n# Heading\n\n", "A **bold** paragraph.\n\n\n", "Next\nline.\n\n  "]);
    expect(chunks.join("")).toBe(markdown);
    expect(splitStreamingMarkdown("A\r\n\r\nB")).toEqual(["A\r\n\r\n", "B"]);
    expect(splitStreamingMarkdown("A\n\n\u00a0")).toEqual(["A\n\n", "\u00a0"]);
    expect(splitStreamingMarkdown("\n\n  ")).toEqual(["\n\n  "]);
  });

  it.each([
    "[unclosed", "[a](./file.md)", "[^footnote]", "[ref]: /file", "`inline code`",
    "```ts\nconst x = 1", "~~~ts\nconst x = 1", "- list", "+ list", "* list",
    "1. list", "0) list", "> quote", "---", "___", "***", "heading\n===",
    "A | B\n--- | ---", "Name\n:---:\nValue", "    code", "  \tcode",
    "<div>raw HTML</div>", "$TGD_DIR", "$$x$$", "~strike~", "escaped \\*text", "lone\rreturn", "\uFEFFprefixed",
  ])("uses the full parser for potentially dependent syntax: %j", (source) => {
    expect(splitStreamingMarkdown(`Completed prose.\n\n${source}`)).toBeNull();
  });
});
