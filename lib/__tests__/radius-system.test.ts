import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const STYLE_ROOTS = ["app", "components"];
const SEMANTIC_RADIUS_TOKENS = [
  "hairline",
  "indicator",
  "inline",
  "control-compact",
  "control",
  "control-prominent",
  "row",
  "card",
  "menu",
  "panel",
  "dialog",
  "sheet",
  "composer",
  "message",
  "message-tail",
  "media",
  "pill",
  "circle",
] as const;
const SEMANTIC_VALUE = new RegExp(
  `var\\(--radius-(?:${SEMANTIC_RADIUS_TOKENS.join("|")})\\)`,
  "g",
);

function filesUnder(relativeRoot: string, extensions: Set<string>): string[] {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  return fs.readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) return filesUnder(relativePath, extensions);
    return entry.isFile() && extensions.has(path.extname(entry.name)) ? [relativePath] : [];
  });
}

function unsupportedRemainder(value: string): string {
  return value.replace(SEMANTIC_VALUE, "").replace(/\b0\b/g, "").replace(/\s+/g, "");
}

describe("Original and TRAE radius systems", () => {
  it("define the same primitive scale and semantic component contract", () => {
    const css = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    const originalBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    const traeBlock = css.match(/html\[data-ui-style="trae"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

    for (const primitive of ["xs", "sm", "md", "lg", "xl", "2xl"]) {
      expect(originalBlock, `Original is missing --radius-${primitive}`).toContain(`--radius-${primitive}:`);
      expect(traeBlock, `TRAE is missing --radius-${primitive}`).toContain(`--radius-${primitive}:`);
    }
    for (const semantic of SEMANTIC_RADIUS_TOKENS) {
      expect(originalBlock, `Missing semantic token --radius-${semantic}`).toContain(
        `--radius-${semantic}:`,
      );
    }
  });

  it("keeps component CSS on semantic radius roles", () => {
    const failures: string[] = [];
    for (const file of STYLE_ROOTS.flatMap((root) => filesUnder(root, new Set([".css"])))) {
      const css = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const match of css.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
        const value = match[1].trim();
        if (unsupportedRemainder(value)) failures.push(`${file}: ${value}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps inline React radius values on the same semantic contract", () => {
    const failures: string[] = [];
    for (const file of STYLE_ROOTS.flatMap((root) => filesUnder(root, new Set([".ts", ".tsx"])))) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const match of source.matchAll(/borderRadius\s*:\s*(?:"([^"]+)"|'([^']+)'|(0))\s*[,}]/g)) {
        const value = match[1] ?? match[2] ?? match[3];
        if (unsupportedRemainder(value)) failures.push(`${file}: ${value}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
