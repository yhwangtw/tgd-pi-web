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
