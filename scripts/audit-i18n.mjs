import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOTS = ["app", "components"];
const BASELINE_PATH = "scripts/i18n-baseline.json";
const USER_TEXT_ATTRIBUTES = new Set(["aria-label", "aria-description", "alt", "placeholder", "title"]);
const MACHINE_LABELS = new Set([
  "API Key", "HTML", "Markdown", "OAuth", "Git", "TypeScript", "ESLint", "Raw", "URL",
  "English", "with tGD", "tGD", "diff", "binary", "extension", "mermaid", "prototype", "daemon", "git",
]);

function sourceFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "e2e") return [];
      return sourceFiles(target);
    }
    if (!entry.isFile() || !entry.name.endsWith(".tsx") || /\.test\.tsx$/.test(entry.name)) return [];
    return [target];
  });
}

function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}

function looksUserFacing(value) {
  const text = normalize(value);
  if (!text || !/[A-Za-z]{2,}/.test(text) || MACHINE_LABELS.has(text)) return false;
  if (/^(?:https?:|\/api\/|[.#~]|[A-Z0-9_]+$)/.test(text)) return false;
  return true;
}

function fingerprint(file, kind, text) {
  return `${file}|${kind}|${normalize(text)}`;
}

function collect() {
  const findings = new Map();
  for (const file of ROOTS.flatMap(sourceFiles)) {
    const sourceText = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const add = (node, kind, raw) => {
      const text = normalize(raw);
      if (kind === "jsx-expression" && /^[a-z][a-z0-9_-]*$/.test(text)) return;
      if (text.includes("var(--") || text.startsWith("/tgd-") || text === "pi-web") return;
      if (!looksUserFacing(text)) return;
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const id = fingerprint(file, kind, text);
      if (!findings.has(id)) findings.set(id, { id, file, line, kind, text });
    };
    const visit = (node) => {
      if (ts.isJsxText(node)) add(node, "jsx", node.text);
      if (ts.isJsxAttribute(node) && USER_TEXT_ATTRIBUTES.has(node.name.text)) {
        if (node.initializer && ts.isStringLiteral(node.initializer)) add(node, `attr:${node.name.text}`, node.initializer.text);
      }
      if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
        const directStrings = [];
        const gather = (child) => {
          if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) directStrings.push(child);
          else if (ts.isConditionalExpression(child)) {
            gather(child.whenTrue);
            gather(child.whenFalse);
          } else if (ts.isParenthesizedExpression(child)) gather(child.expression);
          else if (ts.isBinaryExpression(child)) {
            if (child.operatorToken.kind === ts.SyntaxKind.PlusToken) {
              gather(child.left);
              gather(child.right);
            } else if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(child.operatorToken.kind)) {
              gather(child.right);
            }
          }
        };
        gather(node.expression);
        for (const literal of directStrings) add(literal, "jsx-expression", literal.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...findings.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const findings = collect();
if (process.argv.includes("--print-baseline")) {
  console.log(JSON.stringify(findings.map(({ id }) => id), null, 2));
  process.exit(0);
}

const baseline = new Set(JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")));
const current = new Set(findings.map(({ id }) => id));
const added = findings.filter(({ id }) => !baseline.has(id));
const stale = [...baseline].filter((id) => !current.has(id));

if (added.length || stale.length) {
  if (added.length) {
    console.error(`i18n audit found ${added.length} new hard-coded user-facing string(s):`);
    for (const finding of added) console.error(`${finding.file}:${finding.line} ${JSON.stringify(finding.text)}`);
  }
  if (stale.length) {
    console.error(`i18n baseline has ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"}; remove translated strings from ${BASELINE_PATH}:`);
    for (const id of stale) console.error(id);
  }
  process.exit(1);
}

console.log(`i18n audit passed (${baseline.size} reviewed legacy string${baseline.size === 1 ? "" : "s"} remain in the baseline).`);
