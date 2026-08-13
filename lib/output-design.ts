export type OutputCardKind = "result" | "info" | "warning" | "error";

export type OutputSegment =
  | { type: "markdown"; content: string }
  | {
      type: "card";
      kind: OutputCardKind;
      title?: string;
      content: string;
      details?: string;
      detailsTitle?: string;
    };

const OUTPUT_DIRECTIVE = /^ {0,3}> ?\[!(RESULT|INFO|WARNING|ERROR)\](?:[ \t]+(.+?))?[ \t]*$/i;
const DETAILS_DIRECTIVE = /^\[!DETAILS\](?:[ \t]+(.+?))?[ \t]*$/i;

/**
 * Pi Web output cards deliberately use readable Markdown blockquotes instead
 * of a proprietary JSON envelope. Outside the Web UI the answer still reads
 * as an ordinary quote, while the transcript can progressively enhance the
 * small subset of outcomes that benefit from structure.
 */
export function parseOutputSegments(markdown: string): OutputSegment[] {
  const lines = markdown.split(/\r?\n/);
  const segments: OutputSegment[] = [];
  const plain: string[] = [];
  let fence: { marker: string; size: number } | null = null;

  const flushPlain = () => {
    const content = plain.join("\n").replace(/^\n+|\n+$/g, "");
    plain.length = 0;
    if (content) segments.push({ type: "markdown", content });
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const size = fenceMatch[1].length;
      if (!fence) fence = { marker, size };
      else if (marker === fence.marker && size >= fence.size) fence = null;
      plain.push(line);
      index += 1;
      continue;
    }

    const directive = !fence ? line.match(OUTPUT_DIRECTIVE) : null;
    if (!directive) {
      plain.push(line);
      index += 1;
      continue;
    }

    flushPlain();
    const quoteLines: string[] = [];
    index += 1;
    while (index < lines.length) {
      const quoted = lines[index].match(/^ {0,3}> ?(.*)$/);
      if (!quoted) break;
      quoteLines.push(quoted[1]);
      index += 1;
    }

    const detailsIndex = quoteLines.findIndex((quotedLine) => DETAILS_DIRECTIVE.test(quotedLine));
    const mainLines = detailsIndex >= 0 ? quoteLines.slice(0, detailsIndex) : quoteLines;
    const detailLines = detailsIndex >= 0 ? quoteLines.slice(detailsIndex + 1) : [];
    const detailsTitle = detailsIndex >= 0
      ? quoteLines[detailsIndex].match(DETAILS_DIRECTIVE)?.[1]?.trim()
      : undefined;
    const detailContent = detailLines.join("\n").replace(/^\n+|\n+$/g, "");

    segments.push({
      type: "card",
      kind: directive[1].toLowerCase() as OutputCardKind,
      ...(directive[2]?.trim() ? { title: directive[2].trim() } : {}),
      content: mainLines.join("\n").replace(/^\n+|\n+$/g, ""),
      ...(detailContent ? { details: detailContent } : {}),
      ...(detailsTitle ? { detailsTitle } : {}),
    });
  }

  flushPlain();
  return segments.length > 0 ? segments : [{ type: "markdown", content: markdown }];
}

export function hasStructuredOutputDirective(markdown: string): boolean {
  return parseOutputSegments(markdown).some((segment) => segment.type === "card");
}

export const PI_WEB_OUTPUT_GUIDANCE = `Pi Web renders normal Markdown as the default response format. Keep conversational answers, progress notes, and simple explanations as ordinary Markdown.

When a completed task has one compact, high-value outcome that is easier to scan as structured evidence, append at most one primary output block using this readable Markdown form:

> [!RESULT] Optional short title
> - Key: value
> - Key: value
> [!DETAILS]
> Optional raw commands, logs, or verbose evidence that should start collapsed

Available semantic markers are RESULT, INFO, WARNING, and ERROR. Use RESULT only for a verified outcome, INFO for reusable factual context, WARNING only for an actionable caution, and ERROR only when the requested task actually failed. The text after the marker is the single outcome title; do not repeat it as a bold line inside the block. Do not create a block for ordinary prose, status chatter, or every section. Prefer one block, keep labels short, put explanation before it, and omit DETAILS when there is nothing useful to hide. Do not explain or expose this syntax to the user.`;

export function appendPiWebOutputGuidance(base: string[]): string[] {
  return base.includes(PI_WEB_OUTPUT_GUIDANCE) ? [...base] : [...base, PI_WEB_OUTPUT_GUIDANCE];
}
