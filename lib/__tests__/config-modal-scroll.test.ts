import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe.each(["SkillsConfig.module.css", "ModelsConfig.module.css"])(
  "%s scroll contract",
  (fileName) => {
    const css = readFileSync(join(ROOT, "components/modals", fileName), "utf8");

    it("keeps the dialog body and split layout shrinkable", () => {
      expect(rule(css, ".shellBody")).toMatch(/display:\s*flex/);
      expect(rule(css, ".shellBody")).toMatch(/flex-direction:\s*column/);
      expect(rule(css, ".shellBody")).toMatch(/min-height:\s*0/);
      expect(rule(css, ".layout")).toMatch(/min-height:\s*0/);
      expect(rule(css, ".sidebar")).toMatch(/min-height:\s*0/);
    });

    it.each([".sidebarScroll", ".rightPanel"])(
      "lets %s own vertical wheel and touch scrolling",
      (selector) => {
        const declarations = rule(css, selector);
        expect(declarations).toMatch(/overflow-y:\s*auto/);
        expect(declarations).toMatch(/overscroll-behavior:\s*contain/);
        expect(declarations).toMatch(/touch-action:\s*pan-y/);
      },
    );
  },
);
