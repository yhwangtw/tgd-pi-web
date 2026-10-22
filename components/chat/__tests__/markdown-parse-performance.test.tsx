// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { MarkdownBody } from "../MarkdownBody";

const fixture = vi.hoisted(() => ({ parses: 0, inputs: [] as string[], mermaidLoads: 0 }));
vi.mock("remark-gfm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remark-gfm")>();
  return { default: function countedGfm(this: unknown, ...args: Parameters<typeof actual.default>) {
    fixture.parses++;
    actual.default.apply(this as never, args);
    return (_tree: unknown, file: { value: unknown }) => { fixture.inputs.push(String(file.value)); };
  } };
});
beforeEach(() => { fixture.parses = 0; fixture.inputs = []; });
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
    "\n\nName | Value\n--- | ---\nA | B",
    "\n\nName\n:---:\nValue",
    "\n\n> quoted\n\n> text",
    "\n\n<div>\n\nraw HTML\n</div>",
    "\n\n    indented code\n\n    more code",
    "\n\n```ts\nconst value = 1;\n```",
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
      if (suffix.includes("Name")) expect(host.querySelectorAll("table")).toHaveLength(1);
      if (suffix.includes("```")) expect(host.querySelector("pre code")!.textContent).toBe("const value = 1;");
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
