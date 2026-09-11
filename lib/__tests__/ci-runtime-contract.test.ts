import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
const job = (id: string) => workflow.match(new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "m"))?.[1] ?? "";
describe("runtime and installation CI contract", () => {
  it("runs real minimum/runtime Node versions on Linux and macOS", () => {
    const runtime = job("runtime-tests");
    expect(runtime).toContain("os: [ubuntu-latest, macos-latest]");
    expect(runtime).toContain("node: ['22.19.0', '23.4.0', '24']");
    expect(runtime).toContain("node-version: ${{ matrix.node }}");
    expect(runtime).toContain("runs-on: ${{ matrix.os }}");
    expect(runtime).toContain("run: npm ci");
    expect(runtime).toContain("run: npm test");
    expect(runtime).toContain("run: node scripts/check-node-version.mjs");
    expect(runtime).not.toContain("continue-on-error: true");
  });
  it("runs the actual archive/offline setup smoke on both operating systems", () => {
    const smoke = job("installation-smoke");
    expect(smoke).toContain("os: [ubuntu-latest, macos-latest]");
    expect(smoke).toContain("run: npm ci");
    expect(smoke).toContain("run: node scripts/ci-install-smoke.mjs");
  });
  it("keeps the exact five release-gate job names and makes Test fail closed", () => {
    for (const name of ["Lint & Typecheck", "Test", "Build", "E2E", "Security Audit"]) {
      expect(workflow.match(new RegExp(`^    name: ${name.replace(/&/g, "\\&")}$`, "gm"))).toHaveLength(1);
    }
    const aggregate = job("test");
    expect(aggregate).toContain("needs: [runtime-tests, installation-smoke]");
    expect(aggregate).toContain("if: ${{ always() }}");
    expect(aggregate).toContain('test "$RUNTIME_RESULT" = success');
    expect(aggregate).toContain('test "$INSTALL_RESULT" = success');
    expect(job("build")).toContain("needs: [lint, test]");
    expect(job("e2e")).toContain("needs: [lint, test]");
  });
});
