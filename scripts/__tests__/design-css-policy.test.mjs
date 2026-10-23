import { describe, expect, it } from "vitest";
import { customPropertyDefinitions, undefinedVariableViolations, parseColor, composite, contrastRatio,
  resolveColorValue, themePalettes, paletteContrastReport } from "../design-css-policy.mjs";

const cssFiles = css => new Map([["app/globals.css", ":root { --text: #111; }"], ["components/Example.module.css", css]]);
describe("syntax-aware custom property validation", () => {
  it("ignores comments, quoted content and URLs; accepts local/global definitions", () => {
    const files = cssFiles('/* var(--comment) */ .a { --local: 2px; content: "var(--quote)"; background-image: url("var(--url)"); padding: var(--local); color: var(--text); }');
    expect(undefinedVariableViolations(files)).toEqual([]);
    expect([...customPropertyDefinitions(files.get("components/Example.module.css"))]).toEqual(["--local"]);
  });
  it("accepts literal, nested and empty fallbacks without a broad token waiver", () => {
    expect(undefinedVariableViolations(cssFiles('.a { padding: var(--missing, calc(2px + var(--other, 1px))); margin: var(--optional,); color: var(--text, var(--unused-fallback)); }'))).toEqual([]);
    expect(undefinedVariableViolations(cssFiles('.a { color: var(--missing, var(--also-missing)); }'))[0]).toContain("undefined custom property --also-missing");
  });
  it("rejects a missing token and a same-named sibling component token", () => {
    const files = cssFiles('.a { color: var(--missing); }');
    files.set("components/Other.module.css", ".other { --missing: red; }");
    expect(undefinedVariableViolations(files)).toEqual(["components/Example.module.css:1 undefined custom property --missing in color"]);
  });
  it("accepts precise imported Tailwind definitions and only the owning Radix component", () => {
    const files = cssFiles('.a { color: var(--color-black); max-height: var(--radix-dropdown-menu-content-available-height); }');
    const externalDefinitions = customPropertyDefinitions('@theme { --color-black: #000; }');
    const runtimeDefinitions = new Map([["components/Example.module.css", new Set(["--radix-dropdown-menu-content-available-height"])]]);
    expect(undefinedVariableViolations(files, { externalDefinitions, runtimeDefinitions })).toEqual([]);
    files.set("components/Other.module.css", ".a { height: var(--radix-dropdown-menu-content-available-height); }");
    expect(undefinedVariableViolations(files, { externalDefinitions, runtimeDefinitions })[0]).toContain("components/Other.module.css");
    expect(undefinedVariableViolations(cssFiles('.a { color: var(--color-not-a-tailwind-token); }'), { externalDefinitions })[0]).toContain("undefined custom property");
  });
  it("requires an explicit ancestor contract for inherited component measurements", () => {
    const files = cssFiles('.a { bottom: var(--mobile-nav-height); }');
    const inheritedDefinitions = new Map([["components/Example.module.css", new Set(["--mobile-nav-height"])]]);
    expect(undefinedVariableViolations(files)).toHaveLength(1);
    expect(undefinedVariableViolations(files, { inheritedDefinitions })).toEqual([]);
  });
});

describe("semantic contrast measurement", () => {
  it("composites alpha foregrounds before luminance, including hex alpha", () => {
    expect(contrastRatio(parseColor("#000"), parseColor("#fff"))).toBe(21);
    expect(contrastRatio(parseColor("rgba(0,0,0,0.5)"), parseColor("#fff"))).toBeCloseTo(3.97665, 4);
    expect(composite(parseColor("#ff000080"), parseColor("#fff"))).toEqual([255, 127, 127, 1]);
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual([10, 20, 30, 0.5]);
  });
  it("composites translucent status surfaces onto their actual opaque host", () => {
    const tint = composite(parseColor("rgba(255,255,255,0.5)"), parseColor("#000"));
    expect(tint).toEqual([127.5,127.5,127.5,1]);
    expect(contrastRatio(parseColor("#fff"), tint)).toBeCloseTo(3.97665, 4);
  });
  it("does not turn unsupported or unknown backdrops into passing ratios", () => {
    expect(parseColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseColor("rgb(NaN, 0, 0)")).toBeNull();
    expect(contrastRatio(parseColor("#fff"), parseColor("#0008"))).toBeNull();
    const report = paletteContrastReport([{ skin:"glass", dark:false, values:{"--bg":"#fff8"} }]);
    expect(report.complete).toBe(false);
    expect(report.checks).toEqual([]);
    expect(report.unmeasured[0]).toContain("NOT VERIFIED");
  });
  it("resolves palette aliases and valid fallbacks while rejecting cycles", () => {
    expect(resolveColorValue("var(--accent-text)", {"--accent-text":"var(--accent-hover)","--accent-hover":"#123"})).toBe("#123");
    expect(resolveColorValue("var(--missing, #fff)", {})).toBe("#fff");
    expect(resolveColorValue("var(--a)", {"--a":"var(--b)","--b":"var(--a)"})).toBeNull();
  });
  it("evaluates status/accent text and filled-action foregrounds separately", () => {
    const values = Object.fromEntries(["--bg","--bg-panel","--bg-hover","--bg-selected","--user-bg","--assistant-bg","--tool-bg","--bg-elev-1","--bg-elev-2"].map(key => [key,"#fff"]));
    for (const key of ["--text-muted","--text-dim","--accent-text","--color-success-text","--color-error-text","--color-project-text"]) values[key]="#111";
    for (const key of ["--color-success-bg","--color-error-bg","--color-project-bg","--color-accent-bg"]) values[key]="rgba(0,0,0,0.05)";
    values["--accent"]="#000"; values["--accent-fg"]="#fff";
    const report = paletteContrastReport([{skin:"test",dark:false,values}]);
    expect(report.complete).toBe(true);
    expect(report.violations).toEqual([]);
    values["--color-project-text"]="#aaa";
    values["--accent-fg"]="#111";
    const broken = paletteContrastReport([{skin:"test",dark:false,values}]);
    expect(broken.violations.some(item => item.includes("--color-project-bg over --bg"))).toBe(true);
    expect(broken.violations.some(item => item.includes("filled action"))).toBe(true);
  });
  it("does not mistake nested motion overrides for palette definitions", () => {
    const palettes = themePalettes(':root { --text:#111; } html.dark {--text:#eee;} html[data-skin="test"] {--text:#222;} @media (pointer:coarse) {:root {--text:#bad;}}');
    expect(palettes.map(p => [p.skin,p.dark,p.values["--text"]])).toEqual([["terminal",false,"#111"],["terminal",true,"#eee"],["test",false,"#222"],["test",true,"#222"]]);
  });
});
