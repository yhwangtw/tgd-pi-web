export interface DesignRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignSnapshot {
  selector: string;
  tagName: string;
  text: string;
  html: string;
  rect: DesignRect;
  viewport: { width: number; height: number };
  styles: Record<string, string>;
  interaction?: Record<string, string | number | boolean>;
}

export interface ParsedDesignContext {
  element: string;
  selector: string;
  viewport: { width: number; height: number } | null;
  visibleText: string;
  raw: string;
}

/**
 * Recognize the stable prompt block emitted by DesignInspector. The complete
 * payload remains available for copy/edit/rerun, while the transcript can
 * present it as a compact reference instead of a wall of implementation data.
 */
export function parseDesignContext(value: string): ParsedDesignContext | null {
  const match = value.trim().match(/^<design-context>\s*\n([\s\S]*?)\n<\/design-context>$/);
  if (!match) return null;

  const body = match[1];
  const selected = body.match(/^Selected\s+(\S+)\s+at\s+(.+?)\.\s*$/m);
  const viewport = body.match(/^Viewport:\s*(\d+)×(\d+)px\.\s*$/m);
  const visibleText = body.match(/^Visible text:\s*(.*)$/m)?.[1]?.trim() ?? "";

  return {
    element: selected?.[1] ?? "element",
    selector: selected?.[2] ?? "",
    viewport: viewport
      ? { width: Number(viewport[1]), height: Number(viewport[2]) }
      : null,
    visibleText: visibleText === "(none)" ? "" : visibleText,
    raw: value.trim(),
  };
}

/**
 * Turn a selected DOM node into a compact, model-friendly design brief.
 * Keep this format stable: it is pasted into a prompt and may be saved in a
 * user's draft/history.
 */
export function formatDesignContext(snapshot: DesignSnapshot): string {
  const styleLines = Object.entries(snapshot.styles)
    .filter(([, value]) => value)
    .map(([name, value]) => `  ${name}: ${value}`)
    .join("\n");
  const rect = snapshot.rect;
  const interactionLines = Object.entries(snapshot.interaction ?? {})
    .map(([name, value]) => `  ${name}: ${String(value)}`)
    .join("\n");
  return [
    "<design-context>",
    `Selected ${snapshot.tagName.toLowerCase()} at ${snapshot.selector}.`,
    `Viewport: ${snapshot.viewport.width}×${snapshot.viewport.height}px.`,
    `Bounds: x=${Math.round(rect.x)}, y=${Math.round(rect.y)}, width=${Math.round(rect.width)}, height=${Math.round(rect.height)}px.`,
    snapshot.text ? `Visible text: ${snapshot.text}` : "Visible text: (none)",
    "Computed styles:",
    styleLines || "  (none)",
    "Interaction and accessibility:",
    interactionLines || "  (none)",
    "HTML snapshot:",
    "```html",
    snapshot.html,
    "```",
    "Use this as a visual/reference target. Preserve the app's existing design tokens and responsive behavior; do not copy generated class names blindly.",
    "</design-context>",
  ].join("\n");
}
