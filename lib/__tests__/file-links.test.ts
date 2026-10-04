import { describe, it, expect } from "vitest";
import { looksLikeFilePath, parseMarkdownFileLink } from "../file-links";

describe("looksLikeFilePath", () => {
  it("bare filename with known extension", () => {
    expect(looksLikeFilePath("package.json")).toEqual({ path: "package.json", line: undefined });
  });

  it("nested path", () => {
    expect(looksLikeFilePath("src/index.ts")).toEqual({ path: "src/index.ts", line: undefined });
  });

  it(":line suffix", () => {
    expect(looksLikeFilePath("src/index.ts:42")).toEqual({ path: "src/index.ts", line: 42 });
  });

  it(":line:col suffix", () => {
    expect(looksLikeFilePath("src/index.ts:42:7")).toEqual({ path: "src/index.ts", line: 42 });
  });

  it("relative prefixes qualify without a known extension", () => {
    expect(looksLikeFilePath("./scripts/build")).toEqual({ path: "./scripts/build", line: undefined });
    expect(looksLikeFilePath("/etc/hosts")).toEqual({ path: "/etc/hosts", line: undefined });
  });

  it("property access is not a file", () => {
    expect(looksLikeFilePath("state.contextUsage")).toBeNull();
    expect(looksLikeFilePath("object.property")).toBeNull();
  });

  it("prose slashes are not files", () => {
    expect(looksLikeFilePath("and/or")).toBeNull();
    expect(looksLikeFilePath("either/or")).toBeNull();
  });

  it("URLs are not files", () => {
    expect(looksLikeFilePath("https://example.com/a.ts")).toBeNull();
  });

  it("commands and identifiers are not files", () => {
    expect(looksLikeFilePath("useState")).toBeNull();
    expect(looksLikeFilePath("npm run build")).toBeNull();
  });

  it("trailing slash / dot dirs are not links", () => {
    expect(looksLikeFilePath("src/")).toBeNull();
    expect(looksLikeFilePath("..")).toBeNull();
  });

  it("well-known extension-less filenames are files", () => {
    expect(looksLikeFilePath("Makefile")).toEqual({ path: "Makefile", line: undefined });
    expect(looksLikeFilePath("Dockerfile")).toEqual({ path: "Dockerfile", line: undefined });
    expect(looksLikeFilePath("docker/Dockerfile")).toEqual({ path: "docker/Dockerfile", line: undefined });
    expect(looksLikeFilePath("Makefile:12")).toEqual({ path: "Makefile", line: 12 });
  });
});

describe("Markdown file destinations", () => {
  it("accepts Unicode, spaces, file URLs and line suffixes", () => {
    expect(parseMarkdownFileLink("/工作區/報告%20摘要.pdf")).toEqual({ path: "/工作區/報告 摘要.pdf", line: undefined });
    expect(parseMarkdownFileLink("file:///workspace/my%20file.ts#L42-L45")).toEqual({ path: "/workspace/my file.ts", line: 42 });
    expect(parseMarkdownFileLink("index.ts:42:7")).toEqual({ path: "index.ts", line: 42 });
    expect(parseMarkdownFileLink("src/index.ts:42:7")).toEqual({ path: "src/index.ts", line: 42 });
  });
  it("resolves preview links against the document, leaving chat links relative to cwd", () => {
    expect(parseMarkdownFileLink("../報告.md", "/project/docs/guide.md")?.path).toBe("/project/報告.md");
    expect(parseMarkdownFileLink("docs/report.md")?.path).toBe("docs/report.md");
    expect(parseMarkdownFileLink("demo.html")?.mode).toBe("preview");
    expect(parseMarkdownFileLink("demo.html#L4")).toEqual({ path: "demo.html", line: 4 });
    expect(parseMarkdownFileLink("./a%23b.md")?.path).toBe("./a#b.md");
  });
  it.each(["https://example.com/a.md", "//example.com/a.md", "file://server/a.md", "javascript:alert(1)", "javascript%3Aalert(1).md", "data:text/html,test", "mailto:a@example.com", "#heading", "?session=123", "/api/thing?type=raw", "./bad%00.md", "./broken%.md"])("leaves non-files and unsafe destinations alone: %s", (href) => {
    expect(parseMarkdownFileLink(href)).toBeNull();
  });
});
