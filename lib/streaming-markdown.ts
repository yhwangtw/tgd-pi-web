/**
 * A deliberately small safe subset, not an incremental CommonMark parser.
 * Only independent prose / ATX-heading blocks may be cached during streaming.
 * Recheck the whole input: a newly appended definition, fence, list, table,
 * HTML or math construct must immediately return to the full-document parser.
 */
export function splitStreamingMarkdown(markdown: string): string[] | null {
  // Brackets include reference links / footnotes whose definitions may occur
  // much later. Code, HTML, math and escapes also need their original context.
  // Lone CR and BOM are excluded because parsing each chunk preprocesses them.
  if (/[\[\]`\\<$|~\uFEFF]|\r(?!\n)/.test(markdown)) return null;
  // Lists, blockquotes, thematic / setext rules, pipe-less GFM table delimiters
  // and indented code can continue across blank lines. False positives are OK.
  if (/^(?: {0,3}(?:[>*+_=:~-]|\d{1,9}[.)](?=[ \t]|$))| {4}|[ \t]*\t)/m.test(markdown)) return null;

  const chunks: string[] = [];
  const blankLines = /\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g;
  let start = 0;
  for (const match of markdown.matchAll(blankLines)) {
    const end = match.index + match[0].length;
    const chunk = markdown.slice(start, end);
    // Only ASCII whitespace is blank in CommonMark (NBSP is visible content).
    if (/[^ \t\r\n]/.test(chunk)) {
      chunks.push(chunk);
      start = end;
    }
  }
  const tail = markdown.slice(start);
  if (tail) {
    if (/[^ \t\r\n]/.test(tail) || chunks.length === 0) chunks.push(tail);
    else chunks[chunks.length - 1] += tail;
  }
  return chunks.length > 0 ? chunks : [markdown];
}
