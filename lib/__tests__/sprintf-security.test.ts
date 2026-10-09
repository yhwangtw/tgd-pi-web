import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { sprintf, vsprintf } = require("sprintf-js") as {
  sprintf: (format: string, ...args: unknown[]) => string;
  vsprintf: (format: string, args: unknown[]) => string;
};

describe("bounded sprintf used by Mammoth's CLI dependencies", () => {
  it.each(["%.1000000000f", "%1000000000s", "%.999999999999999999999999g"])("rejects excessive formatting without allocating: %s", format => {
    expect(() => sprintf(format, 1)).toThrow(RangeError);
  });
  it("preserves normal formatting and both public exports", () => {
    expect(sprintf("%s %04d %.2f", "document", 3, 1.25)).toBe("document 0003 1.25");
    expect(sprintf("%(name)s", { name: "document" })).toBe("document");
    expect(vsprintf("%2$s %1$s", ["one", "two"])).toBe("two one");
    expect(sprintf("%.100f", 1)).toHaveLength(102);
    expect(sprintf("%10000s", "x")).toHaveLength(10000);
  });
});
