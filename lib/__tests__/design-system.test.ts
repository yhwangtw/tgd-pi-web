import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function filesBelow(dir: string, suffixes: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) return filesBelow(absolute, suffixes);
    return suffixes.some((suffix) => entry.name.endsWith(suffix)) ? [absolute] : [];
  });
}

const componentStyleFiles = [
  ...filesBelow(join(ROOT, "components"), [".module.css"]),
  ...filesBelow(join(ROOT, "app"), [".module.css"]),
];
const componentSourceFiles = [
  ...filesBelow(join(ROOT, "components"), [".tsx"]),
  ...filesBelow(join(ROOT, "app"), [".tsx"]),
];

describe("design system contracts", () => {
  it("defines the shared type, spacing, control, radius, and motion scales", () => {
    const globals = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    for (const token of [
      "--space-1", "--space-2", "--space-3", "--space-4",
      "--control-xs", "--control-md", "--control-touch",
      "--text-2xs", "--text-xs", "--text-sm", "--text-md", "--text-base", "--text-lg", "--text-title",
      "--type-display-size", "--type-title-size", "--type-body-size", "--type-ui-size", "--type-label-size", "--type-meta-size", "--type-code-size",
      "--weight-regular", "--weight-medium", "--weight-semibold", "--weight-bold",
      "--tracking-title", "--tracking-tight", "--tracking-normal", "--tracking-label", "--tracking-wide", "--tracking-caps",
      "--leading-none", "--leading-tight", "--leading-snug", "--leading-ui", "--leading-copy", "--leading-relaxed", "--leading-body",
      "--type-display-leading", "--type-title-leading", "--type-body-leading", "--type-ui-leading", "--type-meta-leading",
      "--radius-xs", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-full",
      "--motion-fast", "--motion-normal", "--motion-slow", "--ease-standard",
    ]) {
      expect(globals, `missing ${token}`).toContain(`${token}:`);
    }
  });

  it("keeps component colors palette-independent", () => {
    const failures = [...componentStyleFiles, ...componentSourceFiles].flatMap((file) => {
      const css = readFileSync(file, "utf8");
      return css.split("\n").flatMap((line, index) =>
        /#[\da-f]{3,8}\b|rgba?\(/i.test(line)
          ? [`${relative(ROOT, file)}:${index + 1} ${line.trim()}`]
          : [],
      );
    });
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("uses the shared font scale in every component stylesheet", () => {
    const failures = componentStyleFiles.flatMap((file) => {
      const css = readFileSync(file, "utf8");
      return [...css.matchAll(/font-size\s*:\s*([^;]+);/g)].flatMap((match) => {
        const value = match[1].trim();
        // Fixed 16px is the deliberate iOS form-control floor that prevents
        // Safari from zooming the viewport when an input receives focus.
        const valid = value.startsWith("var(--text-")
          || value.startsWith("var(--type-")
          || value === "16px"
          || /^(?:0|inherit|[\d.]+e?m)$/.test(value);
        if (valid) return [];
        const line = css.slice(0, match.index).split("\n").length;
        return [`${relative(ROOT, file)}:${line} font-size: ${value}`];
      });
    });
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("uses only the shared typeface, weight, tracking, and leading scales", () => {
    const contracts = [
      { property: "font-family", valid: (value: string) => value.startsWith("var(--font-") || value === "inherit" },
      { property: "font-weight", valid: (value: string) => value.startsWith("var(--weight-") || ["inherit", "normal", "bold", "bolder", "lighter"].includes(value) },
      { property: "letter-spacing", valid: (value: string) => value.startsWith("var(--tracking-") || ["inherit", "normal"].includes(value) },
      { property: "line-height", valid: (value: string) => value.startsWith("var(--leading-") || value.startsWith("var(--type-") || /^(?:normal|inherit|\d+(?:\.\d+)?px)$/.test(value) },
    ];
    const failures = componentStyleFiles.flatMap((file) => {
      const css = readFileSync(file, "utf8");
      return contracts.flatMap(({ property, valid }) =>
        [...css.matchAll(new RegExp(`${property}\\s*:\\s*([^;]+);`, "g"))].flatMap((match) => {
          const value = match[1].trim().replace(/\s*!important$/, "");
          if (valid(value)) return [];
          const line = css.slice(0, match.index).split("\n").length;
          return [`${relative(ROOT, file)}:${line} ${property}: ${value}`];
        }),
      );
    });
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("ships every declared face and prioritizes Traditional Chinese glyphs in every stack", () => {
    const globals = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    for (const asset of [
      "inter-regular.woff2", "inter-medium.woff2", "inter-semibold.woff2", "inter-bold.woff2",
      "jetbrains-mono-regular.woff2", "jetbrains-mono-bold.woff2",
      "noto-sans-tc-regular.woff2", "noto-sans-tc-medium.woff2", "noto-sans-tc-bold.woff2",
    ]) {
      expect(statSync(join(ROOT, "public/fonts", asset)).size, asset).toBeGreaterThan(1_000);
    }
    const monoStack = globals.match(/--font-mono:\s*([^;]+);/)?.[1] ?? "";
    const systemStack = globals.match(/--font-system:\s*([^;]+);/)?.[1] ?? "";
    expect(monoStack.indexOf("'Noto Sans TC'"), monoStack).toBeGreaterThan(0);
    expect(monoStack.indexOf("'Noto Sans TC'"), monoStack).toBeLessThan(monoStack.indexOf("ui-monospace"));
    expect(systemStack.trim().startsWith("'Noto Sans TC'"), systemStack).toBe(true);
  });

  it("pairs ellipsis with an explicit clipping and single-line contract", () => {
    const failures = componentStyleFiles.flatMap((file) => {
      const css = readFileSync(file, "utf8");
      return [...css.matchAll(/([^{}]+)\{([^{}]*text-overflow\s*:\s*ellipsis;[^{}]*)\}/g)].flatMap((match) => {
        const body = match[2];
        if (/overflow(?:-x)?\s*:\s*(?:hidden|clip);/.test(body) && /white-space\s*:\s*nowrap;/.test(body)) return [];
        const line = css.slice(0, match.index).split("\n").length;
        return [`${relative(ROOT, file)}:${line} ${match[1].trim()}`];
      });
    });
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("provides consistent keyboard, touch, disabled, and reduced-motion behavior", () => {
    const globals = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    expect(globals).toContain("@media (pointer: coarse)");
    expect(globals).toContain("min-block-size: var(--control-touch)");
    expect(globals).toContain(":focus-visible");
    expect(globals).toContain('[aria-disabled="true"]');
    expect(globals).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
