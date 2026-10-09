import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as mammoth from "mammoth";

const require = createRequire(import.meta.url);
const JSZip = createRequire(require.resolve("mammoth"))("jszip");
const katex = require("katex") as { renderToString: (source: string, options: Record<string, unknown>) => string };

describe("patched production document renderers", () => {
  it("renders inline/display mathematics without trusting embedded HTML", () => {
    expect(katex.renderToString("E=mc^2", { throwOnError: true })).toContain('class="katex"');
    expect(katex.renderToString("\\frac{a}{b}", { displayMode: true, throwOnError: true })).toContain("katex-display");
    expect(katex.renderToString("\\htmlClass{unsafe}{x}", { trust: false, throwOnError: false })).not.toContain('class="unsafe"');
  });

  it("still converts an actual DOCX archive with external-file access disabled", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>文件預覽相容性</w:t></w:r></w:p></w:body></w:document>');
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const result = await mammoth.convertToHtml({ buffer }, { externalFileAccess: false });
    expect(result.value).toBe("<p>文件預覽相容性</p>");
  });
});
