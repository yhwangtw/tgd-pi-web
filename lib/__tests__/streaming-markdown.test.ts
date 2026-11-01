import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { createStreamingMarkdownSplitter, splitStreamingMarkdown, streamingFencedCode } from "../streaming-markdown";

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
    "[unclosed", "[a](./file.md)", "[^footnote]", "[ref]: /file",
    "- list", "+ list", "* list", "1. list", "0) list", "> quote", "    code", "  \tcode",
    "<div>raw HTML</div>", "$TGD_DIR", "$$x$$", "escaped \\*text", "lone\rreturn", "\uFEFFprefixed",
  ])("uses the full parser for potentially dependent syntax: %j", (source) => {
    expect(splitStreamingMarkdown(`Completed prose.\n\n${source}`)).toBeNull();
  });

  it("splits fenced blocks and tables while leaving literal code contents untouched", () => {
    const chunks = [
      "Prose with `inline code` and ~~strike~~.\n\n",
      "  ````ts\n  <div>[not a reference] $literal\\</div>\n\n```\n  ````\n\n",
      "| Name | Value |\n| :--- | ---: |\n| A | `B` |\n\n",
      "Name\n:---:\nValue\n\n",
      "Final prose.",
    ];
    expect(splitStreamingMarkdown(chunks.join(""))).toEqual(chunks);
    expect(splitStreamingMarkdown("Prose\n```ts\nx\n```\nNext")).toEqual(["Prose\n", "```ts\nx\n```\n", "Next"]);
  });

  it("retains the same boundaries through append-only updates and source replacements", () => {
    const split = createStreamingMarkdownSplitter();
    for (const source of [
      "First.\n\nSecond\n```ts", "First.\n\nSecond\n```ts`invalid", "First.\n\nSecond\n```ts`invalid\n\nTail",
      "First.\n\n```ts\n[ref]: /literal\n```\n\n| A | B |\n| - | - |\n| x | y |\n\nTail",
      "First.\n\n```ts\n[ref]: /literal\n```\n\n| A | B |\n| - | - |\n| x | y |\n\nTail\n\n[ref]: /actual",
      "Replaced.\n\nNew source.",
    ]) expect(split(source), source).toEqual(splitStreamingMarkdown(source));
  });

  it("invalidates cached fences/tables for late references and footnotes at every prefix", () => {
    const split = createStreamingMarkdownSplitter();
    for (const source of [
      "First.\n\n```ts\n[ref]: /literal\n```\n\n| A | B |\n| --- | --- |\n| x | y |\n\nRead [guide][ref].\n\n[ref]: /guide",
      "Changed.\n\n```ts\nliteral\n```\n\nTail[^note].\n\n[^note]: A footnote.",
      "Prose\n```ts`invalid\n\nTail\n\n~~~\ncode\n~~~\nNext",
    ]) {
      for (let end = 1; end <= source.length; end++) {
        const prefix = source.slice(0, end);
        expect(split(prefix), JSON.stringify(prefix)).toEqual(splitStreamingMarkdown(prefix));
      }
    }
  });
});

describe("literal fenced-code adapter", () => {
  const parser = unified().use(remarkParse);
  it.each([
    "```", "```\n", "```\n```", "```ts\nx\n```\n\n", "```ts\nx\n\n",
    "```foo&amp;bar extra\na\0b\n```", "~~~foo\\+bar `metadata`\n<raw> [text] $$math$$\n~~~",
    "  ````js\n\tab\n \tcd\n  \tmore\n\n```\n  ````", " ```js\n\tx\n ```",
    "   ```js\n\tx\n \ty\n  \tz\n   \tw\n   ```", "```js\r\na\r\nb\r\n```\r\n",
    "\n \n~~~\n\ttext\n~~~~\n \t\n", "````\n```not a close\n~~~\n````tail\n````",
  ])("matches the installed CommonMark parser's literal code value at every prefix: %j", (source) => {
    for (let end = 1; end <= source.length; end++) {
      const prefix = source.slice(0, end);
      const adapted = streamingFencedCode(prefix);
      if (!adapted) continue;
      const tree = parser.parse(prefix);
      expect(tree.children, JSON.stringify(prefix)).toHaveLength(1);
      expect(tree.children[0].type, JSON.stringify(prefix)).toBe("code");
      expect(adapted.code, JSON.stringify(prefix)).toBe((tree.children[0] as { value: string }).value);
      const header = parser.parse(adapted.header).children[0];
      expect((header as { lang: string | null }).lang).toBe((tree.children[0] as { lang: string | null }).lang);
    }
  });

  it.each(["Prose\n```ts\nx", "```ts`invalid\nx", "```\nx\n```\nAfter", "    ```\nx", "```\nlone\rreturn"])("falls back for anything other than a standalone fence: %j", (source) => {
    expect(streamingFencedCode(source)).toBeNull();
  });
});
