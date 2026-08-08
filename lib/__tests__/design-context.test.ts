import { describe, expect, it } from "vitest";
import { formatDesignContext, parseDesignContext } from "../design-context";

describe("formatDesignContext", () => {
  it("keeps the selected geometry, styles, and markup in a compact prompt block", () => {
    const output = formatDesignContext({
      selector: ".composer > button",
      tagName: "BUTTON",
      text: "Send",
      html: '<button class="send">Send</button>',
      rect: { x: 12.4, y: 8.8, width: 91.2, height: 32.7 },
      viewport: { width: 390, height: 844 },
      styles: { "background-color": "rgb(0, 128, 96)", "border-radius": "12px" },
      interaction: { role: "button", label: "Send", disabled: false, tabIndex: 0 },
    });

    expect(output).toContain("<design-context>");
    expect(output).toContain(".composer > button");
    expect(output).toContain("Bounds: x=12, y=9, width=91, height=33px.");
    expect(output).toContain("background-color: rgb(0, 128, 96)");
    expect(output).toContain("Interaction and accessibility:");
    expect(output).toContain("disabled: false");
    expect(output).toContain("<button class=\"send\">Send</button>");
    expect(output).toContain("Preserve the app's existing design tokens");
  });

  it("extracts a compact transcript summary without discarding the raw prompt", () => {
    const output = formatDesignContext({
      selector: ".composer > button",
      tagName: "BUTTON",
      text: "Send",
      html: '<button class="send">Send</button>',
      rect: { x: 12, y: 9, width: 91, height: 33 },
      viewport: { width: 390, height: 844 },
      styles: { display: "flex" },
    });

    expect(parseDesignContext(output)).toEqual({
      element: "button",
      selector: ".composer > button",
      viewport: { width: 390, height: 844 },
      visibleText: "Send",
      raw: output,
    });
    expect(parseDesignContext("ordinary user message")).toBeNull();
  });
});
