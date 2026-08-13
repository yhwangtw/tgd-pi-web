import { describe, expect, it } from "vitest";
import {
  PI_WEB_OUTPUT_GUIDANCE,
  appendPiWebOutputGuidance,
  parseOutputSegments,
} from "../output-design";

describe("Pi Web output design grammar", () => {
  it("keeps ordinary Markdown untouched", () => {
    expect(parseOutputSegments("Done.\n\n- one\n- two")).toEqual([
      { type: "markdown", content: "Done.\n\n- one\n- two" },
    ]);
  });

  it("extracts a readable result block with collapsed details", () => {
    expect(parseOutputSegments([
      "The server was restarted.",
      "",
      "> [!RESULT] Development server running",
      "> - URL: `http://localhost:30141`",
      "> - Port: 30141",
      "> [!DETAILS] Technical details",
      "> `npm run dev` exited successfully.",
    ].join("\n"))).toEqual([
      { type: "markdown", content: "The server was restarted." },
      {
        type: "card",
        kind: "result",
        title: "Development server running",
        content: "- URL: `http://localhost:30141`\n- Port: 30141",
        details: "`npm run dev` exited successfully.",
        detailsTitle: "Technical details",
      },
    ]);
  });

  it("does not interpret examples inside code fences", () => {
    const markdown = "```md\n> [!RESULT] Example\n> Not a card\n```";
    expect(parseOutputSegments(markdown)).toEqual([{ type: "markdown", content: markdown }]);
  });

  it("appends model guidance exactly once", () => {
    expect(appendPiWebOutputGuidance(["existing"])).toEqual(["existing", PI_WEB_OUTPUT_GUIDANCE]);
    expect(appendPiWebOutputGuidance([PI_WEB_OUTPUT_GUIDANCE])).toEqual([PI_WEB_OUTPUT_GUIDANCE]);
  });
});
