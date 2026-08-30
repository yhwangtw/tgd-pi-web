import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

const ROOTS = ["app", "components"];
const SPACING_PROPERTIES = new Set([
  "gap", "row-gap", "column-gap",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
]);
const FONT_TOKENS = new Map([
  [10, "2xs"], [11, "2xs"], [12, "2xs"], [13, "sm"], [14, "md"],
  [15, "base"], [16, "lg"], [18, "xl"], [20, "title"], [22, "2xl"], [28, "3xl"],
]);
const LEGACY_SPACING = new Map([
  ["var(--space-0-5)", "var(--space-optical)"],
  ["var(--space-1-5)", "var(--space-2)"],
  ["var(--space-2-5)", "var(--space-3)"],
  ["var(--space-5)", "var(--space-6)"],
]);

function cssFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return cssFiles(target);
    return entry.isFile() && entry.name.endsWith(".css") ? [target] : [];
  });
}

function spacingToken(value) {
  if (value <= 0) return "0";
  if (value <= 2) return "var(--space-optical)";
  if (value <= 5) return "var(--space-1)";
  if (value <= 10) return "var(--space-2)";
  if (value <= 14) return "var(--space-3)";
  if (value <= 20) return "var(--space-4)";
  if (value <= 28) return "var(--space-6)";
  if (value <= 40) return "var(--space-8)";
  return null;
}

function normalizeSpacing(value) {
  return value.replace(/(?<![-\w])([0-9]+(?:\.[0-9]+)?)px\b/g, (match, raw) => {
    const token = spacingToken(Number(raw));
    return token ?? match;
  });
}

function normalizeFontSize(value) {
  const direct = value.match(/^([0-9]+)px$/);
  const scaled = value.match(/^calc\(([0-9]+)px \* var\(--font-scale\)\)$/);
  const size = Number((direct ?? scaled)?.[1]);
  const token = FONT_TOKENS.get(size);
  return token ? `var(--text-${token})` : value;
}

let changedFiles = 0;
let changedDeclarations = 0;
for (const file of ROOTS.flatMap(cssFiles)) {
  const original = fs.readFileSync(file, "utf8");
  const root = postcss.parse(original, { from: file });
  let changed = false;
  root.walkDecls((declaration) => {
    let next = declaration.value;
    for (const [legacy, replacement] of LEGACY_SPACING) next = next.replaceAll(legacy, replacement);
    if (SPACING_PROPERTIES.has(declaration.prop)) next = normalizeSpacing(next);
    if (declaration.prop === "font-size" && file !== "app/globals.css") next = normalizeFontSize(next);
    if (next !== declaration.value) {
      declaration.value = next;
      changed = true;
      changedDeclarations += 1;
    }
  });
  if (changed) {
    fs.writeFileSync(file, root.toString());
    changedFiles += 1;
  }
}
console.log(`Normalized ${changedDeclarations} spacing/type declarations across ${changedFiles} files.`);
