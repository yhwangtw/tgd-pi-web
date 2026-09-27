import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

const ROOTS = ["app", "components"];
const SPACING_PROPERTIES = new Set([
  "gap", "row-gap", "column-gap",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
]);
const GEOMETRY_PROPERTIES = /^(?:width|height|min-|max-|padding|margin|gap|row-gap|column-gap|border-radius|font-size|line-height)/;
const violations = [];

function cssFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return cssFiles(target);
    return entry.isFile() && entry.name.endsWith(".css") ? [target] : [];
  });
}

function sourceFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [target] : [];
  });
}

for (const file of ROOTS.flatMap(cssFiles)) {
  const root = postcss.parse(fs.readFileSync(file, "utf8"), { from: file });
  root.walkDecls((declaration) => {
    const selector = declaration.parent?.selector ?? "";
    const location = `${file}:${declaration.source?.start?.line ?? 0}`;
    if (SPACING_PROPERTIES.has(declaration.prop) && /\d+(?:\.\d+)?px/.test(declaration.value)) {
      violations.push(`${location} use spacing tokens for ${declaration.prop}: ${declaration.value}`);
    }
    if (file !== "app/globals.css" && declaration.prop === "font-size" && /\d+(?:\.\d+)?px/.test(declaration.value)) {
      violations.push(`${location} use type tokens: ${declaration.value}`);
    }
    if (declaration.prop === "border-radius"
      && declaration.value !== "0"
      && !declaration.value.includes("var(--radius-")) {
      violations.push(`${location} use semantic radius tokens: ${declaration.value}`);
    }
    if (selector.includes("data-skin") && GEOMETRY_PROPERTIES.test(declaration.prop)) {
      violations.push(`${location} palette selector must not set geometry: ${declaration.prop}`);
    }
    if (selector.includes("data-ui-style") && /(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(declaration.value)) {
      violations.push(`${location} geometry selector must not hardcode color: ${declaration.value}`);
    }
  });
}

// Visible product icons come from the shared Lucide/Lobe libraries. Handwritten
// SVGs drift in stroke, geometry, sizing, and accessibility behavior between
// Original and TRAE, so keep this as a zero-baseline contract.
for (const file of ROOTS.flatMap(sourceFiles)) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/<svg\b/g)) {
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${file}:${line} use the shared icon library instead of handwritten SVG`);
  }
}

const globals = fs.readFileSync("app/globals.css", "utf8");
const themeRules = new Map();
postcss.parse(globals, { from: "app/globals.css" }).walkRules((rule) => {
  if (!/^:root$|^html\.dark(?:\[data-skin="[^"]+"\])?$|^html\[data-skin="[^"]+"\]$/.test(rule.selector)) return;
  const declarations = themeRules.get(rule.selector) ?? {};
  rule.walkDecls((declaration) => { declarations[declaration.prop] = declaration.value; });
  themeRules.set(rule.selector, declarations);
});

function luminance(hex) {
  const channels = hex.match(/[\da-f]{2}/gi).map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(first, second) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

// Small metadata, excerpts, and hints use these secondary colors on opaque surfaces.
// Check every palette so a theme edit cannot silently reintroduce unreadable text.
const surfaces = ["--bg", "--bg-panel", "--bg-hover", "--bg-selected", "--user-bg", "--assistant-bg", "--tool-bg", "--bg-elev-1", "--bg-elev-2"];
const skins = ["", ...[...themeRules.keys()].flatMap((selector) => {
  const match = selector.match(/^html\[data-skin="([^"]+)"\]$/);
  return match ? [match[1]] : [];
})];
for (const skin of skins) {
  for (const dark of [false, true]) {
    const palette = {
      ...themeRules.get(":root"),
      ...(dark ? themeRules.get("html.dark") : {}),
      ...(skin ? themeRules.get(`html[data-skin="${skin}"]`) : {}),
      ...(skin && dark ? themeRules.get(`html.dark[data-skin="${skin}"]`) : {}),
    };
    for (const textRole of ["--text-muted", "--text-dim"]) {
      const foreground = palette[textRole];
      if (!/^#[\da-f]{6}$/i.test(foreground ?? "")) {
        violations.push(`${skin || "terminal"}: ${textRole} cannot be checked; expected an opaque six-digit hex color`);
        continue;
      }
      for (const surface of [...surfaces, ...(palette["--bg-panel-opaque"] ? ["--bg-panel-opaque"] : [])]) {
        const background = palette[surface];
        // Translucent Glass surfaces require rendered-background inspection.
        if (!/^#[\da-f]{6}$/i.test(background ?? "")) {
          if (skin !== "glass") violations.push(`${skin || "terminal"}: ${surface} cannot be checked; expected an opaque six-digit hex color`);
          continue;
        }
        const ratio = contrastRatio(foreground, background);
        if (ratio < 4.5) {
          violations.push(`${skin || "terminal"}${dark ? " dark" : " light"}: ${textRole} on ${surface} is ${ratio.toFixed(2)}:1 (needs 4.5:1)`);
        }
      }
    }
  }
}

for (const token of [
  "--type-display-size", "--type-body-size", "--type-ui-size", "--type-meta-size",
  "--control-compact", "--control-default", "--control-mobile",
  "--radius-control", "--radius-card", "--radius-dialog", "--radius-sheet",
]) {
  if (!globals.includes(`${token}:`)) violations.push(`app/globals.css missing ${token}`);
}

if (violations.length) {
  console.error(`Design-system audit found ${violations.length} violation(s):`);
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Design-system audit passed.");
