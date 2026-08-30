import {
  defineTool,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OutputCardKind } from "./output-design";

export const STRUCTURED_OUTPUT_TOOL_NAME = "structured_output";

export interface StructuredOutputDetails {
  headline: string;
  summary: string;
  actionItems: string[];
  kind: OutputCardKind;
  details?: string;
}

export const structuredOutputTool = defineTool({
  name: STRUCTURED_OUTPUT_TOOL_NAME,
  label: "Structured Output",
  description: "Finish the current turn with one compact, scannable result card.",
  promptSnippet: "Emit a final structured result card and end the turn",
  promptGuidelines: [
    "Use structured_output only as the final action when a concise result, plan, warning, or failure card improves scanability.",
    "Keep headline short, summary factual, and actionItems concrete. Do not repeat the same content in a normal assistant message.",
    "Choose result only for verified outcomes, info for neutral context, warning for actionable cautions, and error only for actual failure.",
  ],
  parameters: Type.Object({
    headline: Type.String({ description: "Short title for the outcome" }),
    summary: Type.String({ description: "Concise Markdown summary" }),
    actionItems: Type.Array(Type.String(), {
      description: "Ordered next steps or key evidence bullets",
      maxItems: 12,
    }),
    kind: Type.Optional(Type.Union([
      Type.Literal("result"),
      Type.Literal("info"),
      Type.Literal("warning"),
      Type.Literal("error"),
    ], { description: "Semantic tone; defaults to result" })),
    details: Type.Optional(Type.String({ description: "Optional Markdown technical details shown collapsed" })),
  }),
  async execute(_toolCallId, params) {
    const details: StructuredOutputDetails = {
      headline: params.headline.trim(),
      summary: params.summary.trim(),
      actionItems: params.actionItems.map((item) => item.trim()).filter(Boolean),
      kind: params.kind ?? "result",
      ...(params.details?.trim() ? { details: params.details.trim() } : {}),
    };
    return {
      content: [{ type: "text" as const, text: `Structured result: ${details.headline}` }],
      details,
      terminate: true,
    };
  },
});

export function createStructuredOutputExtension(): InlineExtension {
  return {
    name: "Structured Output",
    factory(pi) {
      pi.registerTool(structuredOutputTool);
    },
  };
}
