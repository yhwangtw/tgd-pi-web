import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { budgetFailures, measureInitialJs } from "./audit-js-budget.mjs";

const temporaryDirectories = [];

function createBuildFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-web-js-budget-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "server/app/login"), { recursive: true });
  mkdirSync(join(root, "static/chunks"), { recursive: true });
  writeFileSync(join(root, "build-manifest.json"), JSON.stringify({
    rootMainFiles: ["static/chunks/root.js"],
    polyfillFiles: ["static/chunks/polyfill.js"],
  }));
  writeFileSync(join(root, "static/chunks/root.js"), "const root = 'shared';\n");
  writeFileSync(join(root, "static/chunks/polyfill.js"), "const polyfill = true;\n");
  writeFileSync(join(root, "static/chunks/chat.js"), "const chat = 'route';\n");
  writeFileSync(join(root, "static/chunks/login.js"), "const login = 'route';\n");
  writeFileSync(
    join(root, "server/app/page_client-reference-manifest.js"),
    `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/page"]=${JSON.stringify({
      clientModules: {
        first: { chunks: ["static/chunks/root.js", "static/chunks/chat.js"] },
        duplicate: { chunks: ["static/chunks/chat.js"] },
      },
    })};`,
  );
  writeFileSync(
    join(root, "server/app/login/page_client-reference-manifest.js"),
    `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/login/page"]=${JSON.stringify({
      clientModules: { login: { chunks: ["static/chunks/login.js"] } },
    })};`,
  );
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("initial JavaScript budget audit", () => {
  it("measures unique shared and route chunks for both production entry routes", () => {
    const results = measureInitialJs(createBuildFixture());
    expect(results.map((result) => result.route)).toEqual(["/", "/login"]);
    expect(results.find((result) => result.route === "/")?.chunkCount).toBe(3);
    expect(results.find((result) => result.route === "/login")?.chunkCount).toBe(3);
    expect(results.every((result) => result.rawBytes > 0 && result.gzipBytes > 0)).toBe(true);
  });

  it("reports route-specific raw and gzip budget failures", () => {
    expect(budgetFailures([
      { route: "/", chunkCount: 1, rawBytes: 2_000, gzipBytes: 900 },
      { route: "/login", chunkCount: 1, rawBytes: 500, gzipBytes: 200 },
    ], 1_000, 800)).toEqual([
      "/ raw 2.0 KB > 1.0 KB",
      "/ gzip 0.9 KB > 0.8 KB",
    ]);
  });
});
