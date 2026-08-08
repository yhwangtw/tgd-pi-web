import { describe, expect, it } from "vitest";
import { describeConfiguredPackages, isPinnedPackageSource, normalizeNpmPackageSource, packageSourceKind } from "../package-center";
import { consumePackageMutation, preparePackageMutation } from "../package-confirmation";

describe("package center safety", () => {
  it("accepts package names and rejects executable or path-like input", () => {
    expect(normalizeNpmPackageSource("@scope/pi-tools@1.2.0")).toBe("@scope/pi-tools@1.2.0");
    expect(normalizeNpmPackageSource("npm:pi-tools")).toBe("npm:pi-tools");
    expect(() => normalizeNpmPackageSource("git:https://example.com/x.git")).toThrow(/Only npm/);
    expect(() => normalizeNpmPackageSource("./local-package")).toThrow(/Only npm/);
    expect(() => normalizeNpmPackageSource("pkg\n--unsafe")).toThrow();
  });

  it("classifies and marks only user npm packages mutable", () => {
    const entries = describeConfiguredPackages({
      listConfiguredPackages: () => [
        { source: "npm:alpha", scope: "user", filtered: false },
        { source: "git:github.com/acme/bravo", scope: "user", filtered: false },
        { source: "npm:shared", scope: "user", filtered: false },
        { source: "npm:charlie", scope: "project", filtered: true },
        { source: "npm:shared", scope: "project", filtered: false },
      ],
    });
    expect(entries.map((entry) => [entry.source, entry.mutable])).toEqual([
      ["git:github.com/acme/bravo", false],
      ["npm:alpha", true],
      ["npm:shared", false],
      ["npm:charlie", false],
      ["npm:shared", false],
    ]);
    expect(packageSourceKind("git:github.com/acme/bravo")).toBe("git");
    expect(isPinnedPackageSource("npm:alpha@2.0.0")).toBe(true);
  });

  it("consumes a confirmation token once and binds it to the exact operation", () => {
    const input = { action: "install" as const, source: "npm:alpha", sessionId: "session-1" };
    const confirmation = preparePackageMutation(input);
    expect(consumePackageMutation(confirmation.token, { ...input, source: "npm:other" })).toBe(false);
    expect(consumePackageMutation(confirmation.token, input)).toBe(false);

    const second = preparePackageMutation(input);
    expect(consumePackageMutation(second.token, input)).toBe(true);
    expect(consumePackageMutation(second.token, input)).toBe(false);
  });
});
