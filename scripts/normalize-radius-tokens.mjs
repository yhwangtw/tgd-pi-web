import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

const ROOTS = ["app", "components"];
const SEMANTIC_TOKENS = new Set([
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
]);
const PRIMITIVE_VALUES = new Map([
  ["xs", 3],
  ["sm", 4],
  ["md", 6],
  ["lg", 8],
  ["xl", 12],
  ["2xl", 16],
]);

function cssFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return cssFiles(target);
    return entry.isFile() && entry.name.endsWith(".css") ? [target] : [];
  });
}

function token(name) {
  return `var(--radius-${name})`;
}

function selectorHas(selector, pattern) {
  return pattern.test(selector.toLowerCase());
}

function tokenForSingle(selector, numericValue) {
  if (numericValue <= 1) return token("hairline");
  if (numericValue <= 2) return token("indicator");

  if (selectorHas(selector, /modal|dialog|lightbox|focusdialog/)) return token("dialog");
  if (selectorHas(selector, /sheet|drawer/)) return token("sheet");
  if (selectorHas(selector, /composer|inputcontainer|inputwrapper/) && numericValue >= 12) {
    return token("composer");
  }
  if (selectorHas(selector, /messagebubble|usermessage|userbubble/) && numericValue >= 10) {
    return token("message");
  }
  if (selectorHas(selector, /menu|popover|tooltip|dropdown|palette|contextmenu|slash|mention/)) {
    return token("menu");
  }
  if (selectorHas(selector, /panel/) && numericValue >= 10) return token("panel");
  if (selectorHas(selector, /image|media|preview/) && numericValue >= 8) return token("media");
  if (
    selectorHas(
      selector,
      /card|toast|group|block|summary|empty|error|result|provider|skillitem|snapshot|historyrow|runstate|contentbox|container/,
    ) && numericValue >= 8
  ) {
    return token("card");
  }
  if (selectorHas(selector, /row|item/)) return token("row");
  if (
    selectorHas(
      selector,
      /button|btn|input|field|row|item|selector|tab|close|toggle|search|iconbox|segmented|action/,
    )
  ) {
    if (numericValue <= 5) return token("control-compact");
    if (numericValue <= 10) return token("control");
    return token("control-prominent");
  }

  if (numericValue <= 3) return token("xs");
  if (numericValue <= 5) return token("control-compact");
  if (numericValue <= 7) return token("control");
  if (numericValue <= 9) return token("control-prominent");
  if (numericValue <= 12) return token("card");
  if (numericValue <= 18) return token("panel");
  return token("dialog");
}

function normalizeRadius(selector, rawValue) {
  const value = rawValue.trim();
  if (value === "0" || value === "inherit" || value === "initial" || value === "unset") {
    return value;
  }
  if (value === "50%") return token("circle");
  if (value === "999px" || value === "9999px") return token("pill");
  if (value === "calc(var(--radius-md) - 2px)") return token("control-compact");
  if (value === `${token("lg")} ${token("lg")} 0 0`) {
    return `${token("sheet")} ${token("sheet")} 0 0`;
  }
  const exactToken = value.match(/^var\(--radius-([a-z0-9-]+)\)$/);
  if (exactToken) {
    const name = exactToken[1];
    if (SEMANTIC_TOKENS.has(name)) return value;
    if (name === "full") return token("pill");
    const primitiveValue = PRIMITIVE_VALUES.get(name);
    if (primitiveValue !== undefined) return tokenForSingle(selector, primitiveValue);
  }
  if (value.includes("var(--radius-")) return value;

  const parts = value.split(/\s+/);
  if (parts.length === 4) {
    const parsed = parts.map((part) => (part === "0" ? 0 : Number.parseFloat(part)));
    if (parsed.every(Number.isFinite)) {
      if (parsed[2] === 0 && parsed[3] === 0) {
        return `${token("sheet")} ${token("sheet")} 0 0`;
      }
      const largest = Math.max(...parsed);
      const smallest = Math.min(...parsed);
      if (largest > smallest) {
        return parts
          .map((part, index) => (parsed[index] === smallest ? token("message-tail") : token("message")))
          .join(" ");
      }
    }
  }

  const single = value.match(/^([0-9]+(?:\.[0-9]+)?)px$/);
  if (!single) return value;
  return tokenForSingle(selector, Number.parseFloat(single[1]));
}

let changedFiles = 0;
let changedDeclarations = 0;

for (const file of ROOTS.flatMap(cssFiles)) {
  const original = fs.readFileSync(file, "utf8");
  const root = postcss.parse(original, { from: file });
  let changed = false;

  root.walkDecls("border-radius", (declaration) => {
    const selector = declaration.parent?.selector ?? "";
    const next = normalizeRadius(selector, declaration.value);
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

console.log(`Normalized ${changedDeclarations} radius declarations across ${changedFiles} files.`);
