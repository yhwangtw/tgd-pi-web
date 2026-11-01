type Fence = { marker: string; size: number; indent: number };

function openingFence(line: string): Fence | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[2][0] === "`" && match[3].includes("`"))) return null;
  return { marker: match[2][0], size: match[2].length, indent: match[1].length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return !!match && match[1][0] === fence.marker && match[1].length >= fence.size;
}

/**
 * Split only independent top-level blocks. Containers, definitions, HTML and
 * math deliberately keep the full parser: a later line may change earlier DOM.
 * Fences protect their literal contents; GFM tables and inline code cannot span
 * a blank line, so they can use the same boundaries as prose.
 */
export function splitStreamingMarkdown(markdown: string): string[] | null {
  if (/\uFEFF|\r(?!\n)/.test(markdown)) return null;
  const chunks: string[] = [];
  let start = 0;
  let offset = 0;
  let fence: Fence | null = null;
  let blank = false;
  let closedFence = false;

  const push = (end: number) => {
    if (/[^ \t\r\n]/.test(markdown.slice(start, end))) {
      chunks.push(markdown.slice(start, end));
      start = end;
    }
  };

  while (offset < markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const end = newline < 0 ? markdown.length : newline + 1;
    const line = markdown.slice(offset, newline < 0 ? end : newline).replace(/\r$/, "");
    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
        closedFence = true;
      }
    } else if (/^[ \t]*$/.test(line)) {
      blank = true;
    } else {
      if (blank || closedFence) push(offset);
      blank = false;
      closedFence = false;
      const opening = openingFence(line);
      if (opening) {
        // A terminated opener interrupts prose. An unfinished info string can
        // still acquire a backtick and become prose on the next stream update.
        if (newline >= 0) push(offset);
        fence = opening;
      } else {
        if (/[\[\]\\<$]/.test(line)) return null;
        // Lists/quotes and indented code can continue across blank lines.
        if (/^(?: {0,3}(?:>|[*+-](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))| {4}|[ \t]*\t)/.test(line)) return null;
      }
    }
    offset = end;
  }

  const tail = markdown.slice(start);
  if (tail) {
    if (/[^ \t\r\n]/.test(tail) || chunks.length === 0) chunks.push(tail);
    else chunks[chunks.length - 1] += tail;
  }
  return chunks.length > 0 ? chunks : [markdown];
}

/** Retain checked, immutable blocks instead of scanning the entire stream. */
export function createStreamingMarkdownSplitter() {
  let previous = "";
  let completed: string[] = [];
  let completedLength = 0;
  return (markdown: string): string[] | null => {
    if (!markdown.startsWith(previous)) {
      completed = [];
      completedLength = 0;
    }
    previous = markdown;
    const tail = splitStreamingMarkdown(markdown.slice(completedLength));
    if (!tail) return null;
    const chunks = [...completed, ...tail];
    for (const chunk of tail.slice(0, -1)) {
      completed.push(chunk);
      completedLength += chunk.length;
    }
    return chunks;
  };
}

/**
 * The existing Markdown code component can receive a fenced block's literal
 * value without asking GFM to tokenize its growing body. Parse only the opener
 * to retain the parser's info-string decoding and language behavior.
 */
export function streamingFencedCode(markdown: string): { header: string; code: string } | null {
  if (/\uFEFF|\r(?!\n)/.test(markdown)) return null;
  let offset = 0;
  let fence: Fence | null = null;
  let header = "";
  const body: string[] = [];
  let closed = false;
  while (offset < markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const end = newline < 0 ? markdown.length : newline + 1;
    const sourceLine = markdown.slice(offset, end);
    const line = markdown.slice(offset, newline < 0 ? end : newline).replace(/\r$/, "");
    if (!fence) {
      if (/^[ \t]*$/.test(line)) { offset = end; continue; }
      fence = openingFence(line);
      if (!fence) return null;
      header = line + "\n";
    } else if (closed) {
      if (!/^[ \t]*$/.test(line)) return null;
    } else if (closesFence(line, fence)) {
      closed = true;
    } else {
      // Removing part of a leading tab leaves its unconsumed virtual spaces.
      let index = 0;
      let removed = 0;
      let padding = "";
      while (removed < fence.indent && index < sourceLine.length) {
        if (sourceLine[index] === " ") { removed++; index++; }
        else if (sourceLine[index] === "\t") {
          const width = 4 - (removed % 4);
          const consumed = Math.min(width, fence.indent - removed);
          padding = " ".repeat(width - consumed);
          removed += consumed;
          index++;
        } else break;
      }
      body.push(padding + sourceLine.slice(index));
    }
    offset = end;
  }
  if (!fence) return null;
  // mdast removes one terminal source line ending and replaces NUL. Interior
  // CRLFs and tabs remain literal, including at an unfinished fence's EOF.
  return { header, code: body.join("").replace(/\r?\n$/, "").replace(/\0/g, "\uFFFD") };
}
