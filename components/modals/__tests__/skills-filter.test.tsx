// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SkillsConfig } from "../SkillsConfig";
vi.mock("../SkillDetail", () => ({ SkillDetail: ({ skill }: { skill: { name: string } }) => <button data-skill-toggle>{skill.name}</button> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("cannot toggle a previously selected skill after filtering it out, then restores it after clearing", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ skills: [{ name: "Visible skill", description: "fixture", filePath: "/project/SKILL.md", sourceInfo: { scope: "project" } }] }))));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<SkillsConfig cwd="/project" onClose={() => {}} />));
    expect(document.querySelector("[data-skill-toggle]")?.textContent).toBe("Visible skill");
    const search = document.querySelector<HTMLInputElement>('[data-testid="skills-config-nav"] input')!;
    const fill = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await fill("not-a-match");
    expect(document.querySelector("[data-skill-toggle]")).toBeNull();
    expect(document.querySelector('[data-testid="skills-config-detail"]')?.textContent).toContain("No matching skills");
    await fill("");
    expect(document.querySelector("[data-skill-toggle]")?.textContent).toBe("Visible skill");
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
