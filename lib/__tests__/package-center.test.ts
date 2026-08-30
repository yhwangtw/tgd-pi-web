import { describe, expect, it } from "vitest";
import {
  buildPackageMutationPreview,
  describeConfiguredPackages,
  inspectNpmPackageSource,
  inspectPackageManifest,
  isPinnedPackageSource,
  normalizeNpmPackageSource,
  packageSourceKind,
  parseNpmPackageSource,
} from "../package-center";
import { consumePackageMutation, consumePreparedPackageMutation, preparePackageMutation } from "../package-confirmation";

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

  it("keeps the exact reviewed version and integrity inside the one-time confirmation", () => {
    const input = {
      action: "install" as const,
      source: "npm:alpha",
      sessionId: "session-1",
      resolvedSource: "npm:alpha@2.3.4",
      integrity: "sha512-reviewed",
    };
    const confirmation = preparePackageMutation(input);
    expect(consumePreparedPackageMutation(confirmation.token, input)).toMatchObject(input);
    expect(consumePreparedPackageMutation(confirmation.token, input)).toBeNull();
  });

  it("derives conservative permissions from a package manifest", () => {
    const inspection = inspectPackageManifest("npm:alpha", {
      name: "alpha",
      version: "2.3.4",
      description: "Example package",
      pi: {
        extensions: ["./extensions/index.ts"],
        skills: ["./skills/review"],
        themes: ["./themes/dark.json"],
      },
      dependencies: { zod: "1", ky: "1" },
      peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
      scripts: { postinstall: "node setup.js" },
      bin: { alpha: "bin/alpha.js" },
      dist: { integrity: "sha512-reviewed", unpackedSize: 2048 },
    });

    expect(inspection).toMatchObject({
      resolvedSource: "npm:alpha@2.3.4",
      hasPiManifest: true,
      resources: ["extensions", "skills", "themes"],
      dependencyCount: 2,
      peerDependencyCount: 1,
      lifecycleScripts: ["postinstall"],
      binaries: ["alpha"],
    });
    expect(inspection.permissions).toEqual(expect.arrayContaining([
      { id: "hostCode", level: "declared", count: 1 },
      { id: "filesystem", level: "potential", count: 1 },
      { id: "credentials", level: "potential", count: 1 },
      { id: "modelInstructions", level: "declared", count: 1 },
      { id: "appearance", level: "declared", count: 1 },
      { id: "installScripts", level: "warning", count: 1 },
      { id: "dependencies", level: "declared", count: 2 },
    ]));
  });

  it("previews permission additions between the installed and reviewed versions", () => {
    const current = inspectPackageManifest("npm:alpha", { name: "alpha", version: "1.0.0", pi: { skills: ["skills/a"] } });
    const target = inspectPackageManifest("npm:alpha", { name: "alpha", version: "2.0.0", pi: { extensions: ["extensions/a.ts"] } });
    const preview = buildPackageMutationPreview("update", "npm:alpha", current, target);
    expect(preview.addedPermissions).toEqual(expect.arrayContaining(["hostCode", "filesystem", "process", "network", "credentials"]));
    expect(preview.removedPermissions).toContain("modelInstructions");
  });

  it("inspects only the fixed npm registry origin and validates the returned identity", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        name: "@scope/alpha",
        version: "1.4.0",
        pi: { extensions: ["./index.ts"] },
        dist: { integrity: "sha512-ok" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    expect(parseNpmPackageSource("npm:@scope/alpha@1.4.0")).toEqual({
      source: "npm:@scope/alpha@1.4.0",
      name: "@scope/alpha",
      selector: "1.4.0",
    });
    const inspection = await inspectNpmPackageSource("npm:@scope/alpha@1.4.0", fetchImpl);
    expect(inspection.resolvedSource).toBe("npm:@scope/alpha@1.4.0");
    expect(calls[0]).toBe("https://registry.npmjs.org/%40scope%2Falpha/1.4.0");
  });
});
