import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { customPropertyDefinitions, undefinedVariableViolations, themePalettes, paletteContrastReport } from "./design-css-policy.mjs";
import postcss from "postcss";
import { iconSourceViolations, isProductIconSource, VENDORED_PROVIDER_ARTWORK } from "./design-icon-policy.mjs";

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
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "e2e" ? [] : sourceFiles(target);
    return entry.isFile() && isProductIconSource(target) ? [target] : [];
  });
}

const stylesheets = new Map(ROOTS.flatMap(cssFiles).map(file => [file, fs.readFileSync(file, "utf8")]));
for (const [file, css] of stylesheets) {
  const root = postcss.parse(css, { from: file });
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

// UI icons use the shared Lucide library. The one digest-locked provider
// artwork copy retains its upstream SVGs and MIT attribution; all other product
// SVGs remain subject to the zero-baseline handwritten-icon contract.
const providerLicense = fs.existsSync(VENDORED_PROVIDER_ARTWORK.licenseFile)
  ? fs.readFileSync(VENDORED_PROVIDER_ARTWORK.licenseFile, "utf8") : "";
for (const file of ROOTS.flatMap(sourceFiles)) {
  violations.push(...iconSourceViolations(file, fs.readFileSync(file, "utf8"), providerLicense));
}

const globals = fs.readFileSync("app/globals.css", "utf8");
// Tailwind owns these theme definitions; read the installed import instead of
// maintaining a broad prefix waiver. Radix owns only the precise Content value
// used by ActionMenu (not arbitrary --radix-* properties in other components).
const require = createRequire(import.meta.url);
const externalDefinitions = customPropertyDefinitions(fs.readFileSync(require.resolve("tailwindcss/theme.css"), "utf8"));
const runtimeDefinitions = new Map([["components/ui/ActionMenu.module.css", new Set(["--radix-dropdown-menu-content-available-height"])]]);
// AppShell's phone container supplies this inherited layout measurement to
// transcript action menus. A missing definition in its owner still fails.
const shellDefinitions = customPropertyDefinitions(stylesheets.get("components/layout/AppShell.module.css"));
const inheritedDefinitions = new Map(["components/chat/AssistantMessageView.module.css", "components/chat/UserMessageView.module.css"].map(file => [file,
  new Set(shellDefinitions.has("--mobile-nav-height") ? ["--mobile-nav-height"] : [])]));
violations.push(...undefinedVariableViolations(stylesheets, { externalDefinitions, runtimeDefinitions, inheritedDefinitions }));
const contrast = paletteContrastReport(themePalettes(globals));
violations.push(...contrast.violations);

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
console.log(`Static design-system checks passed (${contrast.checks.length} measured contrast pairs).`);
if (!contrast.complete) {
  const palettes = [...new Set(contrast.unmeasured.map(item => item.split(":")[0]))];
  console.warn(`Contrast coverage INCOMPLETE / NOT VERIFIED for ${palettes.join(", ")} (${contrast.unmeasured.length} translucent/unsupported pairs). Rendered backdrop evidence is required; this static audit does not certify them.`);
}
