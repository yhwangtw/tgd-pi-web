import { describe, expect, it } from "vitest";
import { normalizeSkillSource, resolveSkillInstallTarget } from "../skill-install";

describe("normalizeSkillSource", () => {
  it("accepts and canonicalizes a skills.sh repository source", () => {
    expect(normalizeSkillSource(" vercel-labs/agent-skills@frontend-design ")).toBe(
      "vercel-labs/agent-skills@frontend-design",
    );
    expect(normalizeSkillSource("@vercel-labs/agent-skills@frontend-design")).toBe(
      "vercel-labs/agent-skills@frontend-design",
    );
  });

  it.each([
    "https://github.com/acme/skills",
    "../../tmp/skill@x",
    "acme/repo",
    "acme/repo@skill --global",
    "acme/repo@skill?token=secret",
    "acme\\repo@skill",
  ])("rejects non-repository or CLI-like input: %s", (source) => {
    expect(() => normalizeSkillSource(source)).toThrow(/owner\/repo@skill/);
  });
});

describe("resolveSkillInstallTarget", () => {
  it("binds project installs to an exact known session workspace", () => {
    const target = resolveSkillInstallTarget(
      { source: "acme/skills@review", scope: "project", cwd: "/tmp/work" },
      ["/tmp/work"],
    );
    expect(target.cwd).toBe("/tmp/work");
    expect(target.installPath).toBe("/tmp/work/.pi/agent/skills");
  });

  it("rejects arbitrary project paths", () => {
    expect(() => resolveSkillInstallTarget(
      { source: "acme/skills@review", scope: "project", cwd: "/tmp/other" },
      ["/tmp/work"],
    )).toThrow(/Open this project/);
  });
});
