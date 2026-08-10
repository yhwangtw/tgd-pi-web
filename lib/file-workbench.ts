export interface FileOutlineItem {
  id: string;
  label: string;
  kind: "heading" | "function" | "class" | "component" | "export" | "key";
  line: number;
  level: number;
}

export interface TextSelectionRange {
  startLine: number;
  endLine: number;
  text: string;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "-").replace(/^-|-$/g, "");
}

export function extractFileOutline(content: string, language: string): FileOutlineItem[] {
  const out: FileOutlineItem[] = [];
  const lines = content.split("\n");
  const push = (label: string, kind: FileOutlineItem["kind"], line: number, level = 1) => {
    const clean = label.trim();
    if (!clean) return;
    out.push({ id: `${line}-${slug(clean) || kind}`, label: clean, kind, line, level });
  };

  lines.forEach((line, index) => {
    const n = index + 1;
    if (language === "markdown") {
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (heading) push(heading[2], "heading", n, heading[1].length);
      return;
    }

    if (language === "json") {
      const key = line.match(/^\s{0,12}["']([^"']+)["']\s*:/);
      if (key) push(key[1], "key", n, Math.max(1, Math.floor((line.match(/^\s*/)?.[0].length ?? 0) / 2) + 1));
      return;
    }

    const klass = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (klass) { push(klass[1], "class", n); return; }

    const fn = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (fn) { push(fn[1], "function", n); return; }

    const arrow = line.match(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    if (arrow) {
      const kind = /^[A-Z]/.test(arrow[1]) ? "component" : "function";
      push(arrow[1], kind, n);
      return;
    }

    if (language === "python") {
      const pyClass = line.match(/^\s*class\s+([A-Za-z_][\w]*)/);
      if (pyClass) { push(pyClass[1], "class", n); return; }
      const pyFn = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/);
      if (pyFn) { push(pyFn[1], "function", n); return; }
    }

    const exported = line.match(/^\s*export\s+(?:const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/);
    if (exported) push(exported[1], "export", n);
  });

  return out.slice(0, 500);
}

export function parseDelimitedText(content: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (char === '"' && content[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

export function selectionFromOffsets(content: string, start: number, end: number): TextSelectionRange | null {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(content.length, Math.max(start, end));
  if (from === to) return null;
  const startLine = content.slice(0, from).split("\n").length;
  const endLine = content.slice(0, to).split("\n").length;
  return { startLine, endLine, text: content.slice(from, to) };
}

export function buildFileAgentPrompt(
  action: "explain" | "review" | "fix" | "context" | "diagnostic",
  relativePath: string,
  selection?: TextSelectionRange | null,
  detail?: string,
): string {
  const range = selection ? `:${selection.startLine}${selection.endLine === selection.startLine ? "" : `-${selection.endLine}`}` : "";
  const target = `${relativePath}${range}`;
  const instruction = {
    explain: `Explain ${target}, including its responsibility and important dependencies.`,
    review: `Review ${target} for correctness, maintainability, security, and accessibility risks.`,
    fix: `Fix the issue in ${target}. Preserve unrelated behavior and verify the change.`,
    context: `Use ${target} as context for my next request.`,
    diagnostic: `Fix this diagnostic in ${target}: ${detail ?? "unknown diagnostic"}. Verify the relevant check afterward.`,
  }[action];
  if (!selection?.text) return instruction;
  const fenced = selection.text.length > 8_000 ? `${selection.text.slice(0, 8_000)}\n…` : selection.text;
  return `${instruction}\n\n\`\`\`\n${fenced}\n\`\`\``;
}

export function hexPreview(bytes: Uint8Array, width = 16): string[] {
  const rows: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += width) {
    const chunk = bytes.slice(offset, offset + width);
    const hex = Array.from(chunk, (value) => value.toString(16).padStart(2, "0")).join(" ").padEnd(width * 3 - 1, " ");
    const ascii = Array.from(chunk, (value) => value >= 32 && value < 127 ? String.fromCharCode(value) : ".").join("");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return rows;
}
