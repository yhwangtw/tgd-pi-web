// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { MarkdownBody } from "../MarkdownBody";

const fixture = vi.hoisted(() => ({ parses: 0, inputs: [] as string[], mermaidLoads: 0, chunks: true }));
vi.mock("@/lib/streaming-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/streaming-markdown")>();
  return { ...actual, createStreamingMarkdownSplitter: () => {
    const split = actual.createStreamingMarkdownSplitter();
    return (markdown: string) => fixture.chunks ? split(markdown) : null;
  } };
});
vi.mock("remark-gfm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remark-gfm")>();
  return { default: function countedGfm(this: unknown, ...args: Parameters<typeof actual.default>) {
    fixture.parses++;
    actual.default.apply(this as never, args);
    return (_tree: unknown, file: { value: unknown }) => { fixture.inputs.push(String(file.value)); };
  } };
});
beforeEach(() => { fixture.parses = 0; fixture.inputs = []; fixture.chunks = true; });
vi.mock("mermaid", () => {
  fixture.mermaidLoads++;
  return { default: { initialize: vi.fn(), parse: vi.fn(), render: vi.fn() } };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("does not reparse unchanged Markdown when only streaming metadata or output accessories change", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const markdown = "# Result\n\nA **formatted** answer with [a link](https://example.com).";
  try {
    await act(async () => root.render(<MarkdownBody>{markdown}</MarkdownBody>));
    expect(fixture.parses).toBe(1);
    await act(async () => root.render(<MarkdownBody isStreaming outputAccessory={<span>Updated work log</span>}>{markdown}</MarkdownBody>));
    await act(async () => root.render(<MarkdownBody className="parent-update" outputAccessory={<span>Completed work log</span>}>{markdown}</MarkdownBody>));
    expect(fixture.parses).toBe(1);
    expect(host.textContent).toContain("Completed work log");
    await act(async () => root.render(<MarkdownBody>{markdown + "\n\nAnother sentence."}</MarkdownBody>));
    expect(fixture.parses).toBe(2);
    expect(host.textContent).toContain("Another sentence.");
  } finally { await act(async () => root.unmount()); }
});


it("keeps completed prose DOM and reparses only the active suffix in real assistant output", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  let markdown = "# Result\n\nA **formatted** paragraph.\n\nThe active tail";
  const render = () => act(async () => root.render(<MarkdownBody isStreaming structuredOutput>{markdown}</MarkdownBody>));
  try {
    await render();
    const heading = host.querySelector("h1");
    const paragraph = host.querySelector("p");
    const previousParses = fixture.parses;
    markdown += " grows.";
    await render();
    expect(fixture.inputs.slice(previousParses)).toEqual(["The active tail grows."]);
    expect(host.querySelector("h1")).toBe(heading);
    expect(host.querySelector("p")).toBe(paragraph);
    expect(host.querySelectorAll(".markdown-body")).toHaveLength(1);
    expect(Array.from(host.querySelector(".markdown-body")!.children, (node) => node.tagName)).toEqual(["H1", "P", "P"]);

    markdown += "\n\nNext";
    await render();
    const completedTail = host.querySelectorAll("p")[1];
    const count = fixture.parses;
    markdown += " paragraph.";
    await render();
    expect(fixture.inputs.slice(count)).toEqual(["Next paragraph."]);
    expect(host.querySelectorAll("p")[1]).toBe(completedTail);
    const streamingHtml = host.querySelector(".markdown-body")!.innerHTML;
    await act(async () => root.render(<MarkdownBody structuredOutput>{markdown}</MarkdownBody>));
    expect(fixture.inputs.at(-1)).toBe(markdown);
    expect(host.querySelector(".markdown-body")!.innerHTML).toBe(streamingHtml);
  } finally { await act(async () => root.unmount()); }
});

it("matches full-document DOM for prose, headings, hard breaks, entities and GFM autolinks", async () => {
  const streamingHost = document.createElement("div");
  const completeHost = document.createElement("div");
  const streaming = createRoot(streamingHost);
  const complete = createRoot(completeHost);
  const documents = [
    "",
    "\n\nFirst paragraph.\n\n",
    "# Result\n\nOne **bold** and _emphasized_ paragraph.\n\nAnother paragraph.",
    "  ## Heading\r\n\r\nA line  \r\nwith a hard break.\r\n \r\nA &amp; B.",
    "A soft\nline break.\n\nhttps://example.com and mail@example.com\n\nDone.",
    "\u00a0\n\nVisible nonbreaking whitespace.\n\n\u00a0",
    "A partial **formatted tail\n\nA separate paragraph.",
    "First.\n\n# Heading without a blank line\nA new paragraph.\n\nThird.\n\n\n",
  ];
  try {
    for (const markdown of documents) {
      await act(async () => {
        streaming.render(<MarkdownBody isStreaming structuredOutput>{markdown}</MarkdownBody>);
        complete.render(<MarkdownBody structuredOutput>{markdown}</MarkdownBody>);
      });
      expect(streamingHost.querySelector(".markdown-body")!.innerHTML, JSON.stringify(markdown))
        .toBe(completeHost.querySelector(".markdown-body")!.innerHTML);
    }
  } finally { await act(async () => { streaming.unmount(); complete.unmount(); }); }
});

it("falls back immediately when appended syntax needs whole-document context", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const prefix = "# Result\n\nCompleted prose.\n\nCurrent paragraph.";
  const suffixes = [
    "\n\n[Guide][ref]\n\n[ref]: https://example.com",
    "\n\n- first\n\n- second",
    "\n\n> quoted\n\n> text",
    "\n\n<div>\n\nraw HTML\n</div>",
    "\n\n    indented code\n\n    more code",
  ];
  try {
    for (const suffix of suffixes) {
      await act(async () => root.render(<MarkdownBody isStreaming>{prefix}</MarkdownBody>));
      const count = fixture.parses;
      const markdown = prefix + suffix;
      await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
      expect(fixture.inputs.slice(count)).toEqual([markdown]);
      if (suffix.includes("[Guide]")) expect(host.querySelector("a")!.href).toBe("https://example.com/");
      if (suffix.includes("- first")) expect(host.querySelectorAll("ul > li")).toHaveLength(2);
    }
  } finally { await act(async () => root.unmount()); }
});

it("resolves late references and returns to full rendering for replacements, previews and output cards", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    let markdown = "Read [the guide][ref].\n\nCurrent text.";
    await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
    expect(host.querySelector("a")).toBeNull();
    markdown += "\n\n[ref]: https://example.com/guide";
    await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
    expect(host.querySelector("a")!.href).toBe("https://example.com/guide");

    markdown = "# Revised\n\nReplacement text.\n\nAnother paragraph.";
    await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
    expect(host.textContent).not.toContain("guide");
    let count = fixture.parses;
    await act(async () => root.render(<MarkdownBody isStreaming sourceFilePath="/fixture/README.md">{markdown}</MarkdownBody>));
    expect(fixture.inputs.slice(count)).toEqual([markdown]);
    expect(host.querySelector("h1")!.dataset.sourceLine).toBe("1");

    count = fixture.parses;
    await act(async () => root.render(<MarkdownBody isStreaming allowSafeHtml>{markdown + "\n\n<div>Preview</div>"}</MarkdownBody>));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(host.querySelector(".markdown-body > div")?.textContent).toBe("Preview");
    });
    expect(fixture.inputs.slice(count)).toEqual([markdown + "\n\n<div>Preview</div>"]);
    expect(host.querySelector(".markdown-body > div")!.textContent).toBe("Preview");

    await act(async () => root.render(<MarkdownBody isStreaming structuredOutput>{"Ready.\n\n> [!RESULT] Summary\n> Result text."}</MarkdownBody>));
    expect(host.textContent).toContain("Summary");
    expect(host.textContent).toContain("Result text.");
    expect(host.querySelectorAll(".markdown-body")).toHaveLength(2);
  } finally { await act(async () => root.unmount()); }
});

it("reduces parsed characters on a synthetic multi-paragraph stream and fully renders completion", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const source = Array.from({ length: 24 }, (_, index) =>
    `Paragraph ${index}: **Streaming** prose remains visible. A calm sentence grows with each update.\n\n`,
  ).join("");
  let baselineCharacters = 0;
  try {
    for (let end = 24; end < source.length; end += 24) {
      const markdown = source.slice(0, end);
      baselineCharacters += markdown.length;
      await act(async () => root.render(<MarkdownBody isStreaming structuredOutput>{markdown}</MarkdownBody>));
    }
    baselineCharacters += source.length;
    await act(async () => root.render(<MarkdownBody isStreaming structuredOutput>{source}</MarkdownBody>));
    const parsedCharacters = fixture.inputs.reduce((total, text) => total + text.length, 0);
    expect(parsedCharacters).toBeLessThan(baselineCharacters * 0.12);
    expect(host.querySelectorAll("p")).toHaveLength(24);
    const streamingHtml = host.querySelector(".markdown-body")!.innerHTML;
    const count = fixture.parses;
    await act(async () => root.render(<MarkdownBody structuredOutput>{source}</MarkdownBody>));
    expect(fixture.inputs.slice(count)).toEqual([source]);
    expect(host.querySelector(".markdown-body")!.innerHTML).toBe(streamingHtml);
  } finally { await act(async () => root.unmount()); }
});


it("keeps display math on the full parser and Mermaid preview deferred during streaming", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const math = "# Formula\n\n$$E=mc^2$$\n\nMore text.";
  const normalizedMath = "# Formula\n\n$$\nE=mc^2\n$$\n\nMore text.";
  try {
    await act(async () => root.render(<MarkdownBody isStreaming>{math}</MarkdownBody>));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(host.querySelector(".katex-display")).not.toBeNull();
    });
    expect(fixture.inputs.every((input) => input === normalizedMath)).toBe(true);
    await act(async () => root.render(<MarkdownBody isStreaming>{"Earlier prose.\n\n```mermaid\ngraph TD; A-->B\n```"}</MarkdownBody>));
    const preview = host.querySelector<HTMLButtonElement>('button[title="Preview available after streaming"]');
    expect(preview).not.toBeNull();
    expect(preview!.disabled).toBe(true);
    expect(host.querySelector("pre code")!.textContent).toContain("graph TD; A-->B");
    expect(fixture.mermaidLoads).toBe(0);
  } finally { await act(async () => root.unmount()); }
});

it("chunks prose within structured output cards while retaining whole-document fallback for references", async () => {
  const host = document.createElement("div"); const root = createRoot(host);
  let markdown = "Intro.\n\n> [!RESULT] Summary\n> First **complete** paragraph.\n>\n> Active tail";
  try {
    await act(async () => root.render(<MarkdownBody isStreaming structuredOutput>{markdown}</MarkdownBody>));
    const complete = [...host.querySelectorAll("p")].find((node) => node.textContent === "First complete paragraph.");
    const count = fixture.inputs.length;
    markdown += " grows.";
    await act(async () => root.render(<MarkdownBody isStreaming structuredOutput>{markdown}</MarkdownBody>));
    expect(fixture.inputs.slice(count)).toEqual(["Active tail grows."]);
    expect([...host.querySelectorAll("p")].find((node) => node.textContent === "First complete paragraph.")).toBe(complete);
    markdown += "\n>\n> [Guide][ref]\n>\n> [ref]: https://example.com";
    await act(async () => root.render(<MarkdownBody isStreaming structuredOutput>{markdown}</MarkdownBody>));
    expect(host.querySelector("a")?.href).toBe("https://example.com/");
  } finally { await act(async () => root.unmount()); }
});

it("matches full-parser streaming DOM at every prefix of mixed fences, tables and context-sensitive syntax", async () => {
  const host = document.createElement("div");
  const baselineHost = document.createElement("div");
  const root = createRoot(host); const baseline = createRoot(baselineHost);
  const sources = [
    "# Results\n\nProse with `inline` and ~~strike~~.\n\n```ts\nconst x = '<raw> [ref] $literal';\n\n```\n\n| Name | Value |\n| :--- | ---: |\n| A | `B` |\n\nDone.",
    "Before\n```ts`invalid\n\nParagraph.\n\n~~~foo\\+bar `metadata`\n[ref]: /literal\n~~~~\nAfter",
    "Before\n  ````js\n\tab\n \tcd\n\n```\n  ````tail\n  ````\nAfter\n\nName\n:---:\nValue",
    "# CRLF\r\n\r\n ```foo&amp;bar\r\n\tA\r\n \tB\r\n ```\r\n\r\nNext.",
    "Start.\n\n```\na\0b\n```\n\nRead [guide][ref].\n\n[ref]: https://example.com/guide",
    "Start.\n\n| A | B |\n| - | - |\n| x | y |\n\n- first\n\n- second\n\n> quote\n\n<div>raw</div>",
    "Start.\n\nHeading\n===\n\n---\n\n***\n\n___\n\n**Bold** tail.",
  ];
  try {
    for (const source of sources) {
      for (let end = 1; end <= source.length; end++) {
        const markdown = source.slice(0, end);
        fixture.chunks = true;
        await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
        fixture.chunks = false;
        await act(async () => baseline.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
        expect(host.innerHTML, JSON.stringify(markdown)).toBe(baselineHost.innerHTML);
      }
    }
  } finally {
    fixture.chunks = true;
    await act(async () => { root.unmount(); baseline.unmount(); });
  }
});

it("reuses completed mixed code/table blocks and parses a small fraction of growing source", async () => {
  const host = document.createElement("div"); const root = createRoot(host);
  const source = Array.from({ length: 24 }, (_, index) =>
    `## Section ${index}\n\nA **formatted** paragraph with \`inline\` code.\n\n` +
    `\`\`\`ts\nconst value${index} = '<literal> [reference] $variable';\n${"// a literal code line\n".repeat(8)}\`\`\`\n\n` +
    `| Name | Value |\n| :--- | ---: |\n| Item ${index} | \`value${index}\` |\n| Other | **text** |\n\n`,
  ).join("");
  let baselineCharacters = 0;
  try {
    for (let end = 71; end < source.length + 71; end += 71) {
      const markdown = source.slice(0, Math.min(source.length, end));
      baselineCharacters += markdown.length;
      await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
    }
    const parsedCharacters = fixture.inputs.reduce((total, input) => total + input.length, 0);
    expect(parsedCharacters).toBeLessThan(baselineCharacters * 0.08);
    expect(host.querySelectorAll("h2")).toHaveLength(24);
    expect(host.querySelectorAll("table")).toHaveLength(24);
    expect(host.querySelectorAll("pre code")).toHaveLength(24);
    const table = host.querySelector("table");
    const code = host.querySelector("pre code");
    const count = fixture.inputs.length;
    await act(async () => root.render(<MarkdownBody isStreaming>{source + "Latest tail."}</MarkdownBody>));
    expect(host.querySelector("table")).toBe(table);
    expect(host.querySelector("pre code")).toBe(code);
    expect(fixture.inputs.slice(count).reduce((total, input) => total + input.length, 0)).toBeLessThan(200);
    await act(async () => root.render(<MarkdownBody>{source + "Latest tail."}</MarkdownBody>));
    expect(fixture.inputs.at(-1)).toBe(source + "Latest tail.");
    expect(host.querySelectorAll("table")).toHaveLength(24);
    expect(host.textContent).toContain("Latest tail.");
  } finally { await act(async () => root.unmount()); }
});

it("never reparses the growing body of a large unfinished fence and retains copy/final rendering", async () => {
  const host = document.createElement("div"); const root = createRoot(host);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const body = "const value = '<raw> [reference] $$literal$$';\n".repeat(600);
  try {
    for (let end = 4_000; end <= body.length; end += 4_000) {
      const markdown = "Earlier prose.\n\n```ts\n" + body.slice(0, end);
      await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
      expect(host.querySelector("pre code")!.textContent).toBe(body.slice(0, end).replace(/\n$/, ""));
    }
    expect(fixture.inputs.reduce((total, input) => total + input.length, 0)).toBeLessThan(80);
    const markdown = "Earlier prose.\n\n```ts\n" + body + "```\n\nDone.";
    await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
    expect(host.querySelector("pre code")!.textContent).toBe(body.replace(/\n$/, ""));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click());
    expect(writeText).toHaveBeenLastCalledWith(body.replace(/\n$/, ""));
    await act(async () => root.render(<MarkdownBody>{markdown}</MarkdownBody>));
    expect(fixture.inputs.at(-1)).toBe(markdown);
    expect(host.textContent).toContain("Done.");
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("coalesces only large active parsed blocks with a fixed deadline and flushes completion immediately", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div"); const root = createRoot(host);
  let markdown = "| Name | Value |\n| --- | --- |\n" + "| repeated | value |\n".repeat(900);
  try {
    await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
    expect(host.querySelectorAll("tbody tr")).toHaveLength(900);
    const count = fixture.inputs.length;
    for (let index = 0; index < 6; index++) {
      markdown += `| latest ${index} | value |\n`;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15);
        root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>);
      });
    }
    expect(fixture.inputs).toHaveLength(count);
    await act(async () => { await vi.advanceTimersByTimeAsync(30); });
    expect(fixture.inputs.slice(count)).toEqual([markdown]);
    expect(host.querySelectorAll("tbody tr")).toHaveLength(906);
    markdown += "| final | value |\n";
    await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
    expect(host.querySelectorAll("tbody tr")).toHaveLength(906);
    await act(async () => root.render(<MarkdownBody>{markdown}</MarkdownBody>));
    expect(fixture.inputs.at(-1)).toBe(markdown);
    expect(host.querySelectorAll("tbody tr")).toHaveLength(907);
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
});

it("preserves a later code block's open focus dialog through append, closing fence and full completion", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const host = document.createElement("div"); const root = createRoot(host);
  let markdown = "Intro.\n\n```ts\nconst first = 1;\n```\n\n| A | B |\n| --- | --- |\n| x | y |\n\n```js\nconst second = 2;";
  try {
    await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
    const buttons = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Open focus mode"]');
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[1].click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    for (const suffix of ["\nconst third = 3;", "\n```\n\nFinal paragraph."]) {
      markdown += suffix;
      await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
      expect(document.querySelector('[role="dialog"]')).toBe(dialog);
      expect(dialog!.textContent).toContain("const third = 3;");
    }
    const count = fixture.inputs.length;
    await act(async () => root.render(<MarkdownBody>{markdown}</MarkdownBody>));
    expect(fixture.inputs.slice(count)).toEqual([markdown]);
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog!.textContent).toContain("const second = 2;");
    expect(host.querySelectorAll("table")).toHaveLength(1);
    expect(host.querySelectorAll("pre")).toHaveLength(2);
    await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  } finally { await act(async () => root.unmount()); }
});

it("returns cached mixed blocks to full-document parsing for late footnotes", async () => {
  const host = document.createElement("div"); const root = createRoot(host);
  let markdown = "Intro.\n\n```ts\n[ref]: /literal\n```\n\n| A | B |\n| --- | --- |\n| x | y |\n\nTail.";
  try {
    await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
    const count = fixture.inputs.length;
    markdown += "\n\nFootnote[^note].\n\n[^note]: Explanation.";
    await act(async () => root.render(<MarkdownBody isStreaming>{markdown}</MarkdownBody>));
    expect(fixture.inputs.slice(count)).toEqual([markdown]);
    expect(host.querySelector('[data-footnotes]')!.textContent).toContain("Explanation.");
    expect(host.querySelector('a[data-footnote-ref]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
});
