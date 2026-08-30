import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { X } from "lucide-react";
import { IconButton } from "../IconButton";

describe("IconButton", () => {
  it("provides one accessible label and hides the glyph", () => {
    const html = renderToStaticMarkup(<IconButton label="Close" icon={<X />} />);
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('title="Close"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-size="default"');
    expect(html).toContain('data-variant="ghost"');
  });

  it("preserves semantic states and variants", () => {
    const html = renderToStaticMarkup(
      <IconButton label="Pinned" icon={<X />} size="compact" variant="surface" pressed disabled />,
    );
    expect(html).toContain('data-size="compact"');
    expect(html).toContain('data-variant="surface"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("disabled");
  });
});
