import postcss from "postcss";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Use the same value grammar shipped with Next; do not infer var() from text
// inside comments, strings, URLs, or nested fallbacks with regular expressions.
const valueParser = require("next/dist/compiled/postcss-value-parser");

export function customPropertyDefinitions(css) {
  const names = new Set();
  postcss.parse(css).walkDecls(({ prop }) => { if (prop.startsWith("--")) names.add(prop); });
  return names;
}

function varParts(node) {
  const comma = node.nodes.findIndex(item => item.type === "div" && item.value === ",");
  return {
    name: valueParser.stringify(comma < 0 ? node.nodes : node.nodes.slice(0, comma)).trim(),
    fallback: comma < 0 ? null : node.nodes.slice(comma + 1),
  };
}

export function undefinedVariableViolations(files, { externalDefinitions = new Set(), runtimeDefinitions = new Map(), inheritedDefinitions = new Map() } = {}) {
  const globalDefinitions = customPropertyDefinitions(files.get("app/globals.css") ?? "");
  const violations = [];
  for (const [file, css] of files) {
    const definitions = new Set([...globalDefinitions, ...externalDefinitions,
      ...customPropertyDefinitions(css), ...(runtimeDefinitions.get(file) ?? []), ...(inheritedDefinitions.get(file) ?? [])]);
    const visit = (nodes, declaration) => {
      for (const node of nodes) {
        if (node.type !== "function" || node.value === "url") continue;
        if (node.value !== "var") { visit(node.nodes, declaration); continue; }
        const { name, fallback } = varParts(node);
        if (definitions.has(name)) continue;
        if (fallback !== null) { visit(fallback, declaration); continue; }
        violations.push(`${file}:${declaration.source?.start?.line ?? 0} undefined custom property ${name} in ${declaration.prop}`);
      }
    };
    postcss.parse(css, { from: file }).walkDecls(declaration => visit(valueParser(declaration.value).nodes, declaration));
  }
  return violations;
}

export function resolveColorValue(value, palette, seen = new Set()) {
  if (typeof value !== "string") return null;
  let unresolved = false;
  const parsed = valueParser(value);
  parsed.walk(node => {
    if (node.type !== "function" || node.value !== "var") return;
    const { name, fallback } = varParts(node);
    let resolved = seen.has(name) ? null : resolveColorValue(palette[name], palette, new Set([...seen, name]));
    if (resolved === null && fallback !== null) resolved = resolveColorValue(valueParser.stringify(fallback), palette, seen);
    if (resolved === null) { unresolved = true; return false; }
    node.type = "word";
    node.value = resolved;
    delete node.nodes;
    return false;
  });
  return unresolved ? null : parsed.toString().trim();
}

export function parseColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "transparent") return [0, 0, 0, 0];
  if (/^#[\da-f]{3,4}$/.test(text)) return parseColor(`#${[...text.slice(1)].map(c => c + c).join("")}`);
  if (/^#[\da-f]{6}(?:[\da-f]{2})?$/.test(text)) {
    const channels = text.slice(1).match(/../g).map(c => Number.parseInt(c, 16));
    return [...channels.slice(0, 3), (channels[3] ?? 255) / 255];
  }
  const parsed = valueParser(text).nodes.filter(node => node.type !== "space");
  if (parsed.length !== 1 || parsed[0].type !== "function" || !["rgb", "rgba"].includes(parsed[0].value)) return null;
  const values = parsed[0].nodes.filter(node => node.type === "word").map(node => node.value);
  if (values.length < 3 || values.length > 4 || values.some(v => !/^\d*\.?\d+%?$/.test(v))) return null;
  const channels = values.slice(0, 3).map(v => v.endsWith("%") ? Number.parseFloat(v) * 2.55 : Number(v));
  const alpha = values[3] === undefined ? 1 : values[3].endsWith("%") ? Number.parseFloat(values[3]) / 100 : Number(values[3]);
  if (channels.some(c => c < 0 || c > 255) || alpha < 0 || alpha > 1) return null;
  return [...channels, alpha];
}

export function composite(foreground, background) {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  return [...foreground.slice(0, 3).map((c, i) => alpha === 0 ? 0
    : (c * foreground[3] + background[i] * background[3] * (1 - foreground[3])) / alpha), alpha];
}

function luminance(color) {
  return color.slice(0, 3).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}

export function contrastRatio(foreground, background) {
  if (!foreground || !background || background[3] !== 1) return null;
  const visibleForeground = composite(foreground, background);
  const first = luminance(visibleForeground), second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function themePalettes(globals) {
  const rules = new Map();
  postcss.parse(globals).walkRules(rule => {
    if (!/^:root$|^html\.dark(?:\[data-skin="[^"]+"\])?$|^html\[data-skin="[^"]+"\]$/.test(rule.selector)) return;
    // Responsive/motion overrides are not palette definitions.
    if (rule.parent.type !== "root") return;
    const declarations = rules.get(rule.selector) ?? {};
    rule.each(declaration => { if (declaration.type === "decl") declarations[declaration.prop] = declaration.value; });
    rules.set(rule.selector, declarations);
  });
  const skins = ["", ...[...rules.keys()].flatMap(selector => {
    const match = selector.match(/^html\[data-skin="([^"]+)"\]$/);
    return match ? [match[1]] : [];
  })];
  return skins.flatMap(skin => [false, true].map(dark => ({ skin: skin || "terminal", dark, values: {
    ...rules.get(":root"), ...(dark ? rules.get("html.dark") : {}),
    ...(skin ? rules.get(`html[data-skin="${skin}"]`) : {}),
    ...(skin && dark ? rules.get(`html.dark[data-skin="${skin}"]`) : {}),
  } })));
}

export const TEXT_SURFACES = ["--bg", "--bg-panel", "--bg-hover", "--bg-selected", "--user-bg", "--assistant-bg", "--tool-bg", "--bg-elev-1", "--bg-elev-2"];
export function paletteContrastReport(palettes) {
  const checks = [], violations = [], unmeasured = [];
  for (const { skin, dark, values } of palettes) {
    const label = `${skin} ${dark ? "dark" : "light"}`;
    const color = name => parseColor(resolveColorValue(values[name], values));
    const check = (role, background, surface) => {
      const ratio = contrastRatio(color(role), background);
      const description = `${label}: ${role} on ${surface}`;
      if (ratio === null) { unmeasured.push(`${description}: NOT VERIFIED (unsupported color or translucent backdrop; rendered measurement required)`); return; }
      checks.push({ skin, dark, role, surface, ratio });
      if (ratio < 4.5) violations.push(`${description} is ${ratio.toFixed(2)}:1 (needs 4.5:1)`);
    };
    for (const surface of [...TEXT_SURFACES, ...(values["--bg-panel-opaque"] ? ["--bg-panel-opaque"] : [])]) {
      const background = color(surface);
      for (const role of ["--text-muted", "--text-dim", "--accent-text", "--color-success-text", "--color-error-text", "--color-project-text"]) check(role, background, surface);
      for (const status of ["success", "error", "project"]) {
        const tint = color(`--color-${status}-bg`);
        check(`--color-${status}-text`, tint && background ? composite(tint, background) : null, `--color-${status}-bg over ${surface}`);
      }
      const tint = color("--color-accent-bg");
      check("--accent-text", tint && background ? composite(tint, background) : null, `--color-accent-bg over ${surface}`);
    }
    check("--accent-fg", color("--accent"), "--accent (filled action)");
  }
  return { checks, violations, unmeasured, complete: unmeasured.length === 0 };
}
