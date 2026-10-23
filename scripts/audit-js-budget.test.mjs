import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { budgetFailures, entryScriptChunks, measureInitialJs } from "./audit-js-budget.mjs";
import { javascriptBudget } from "./js-budget-policy.mjs";

const temporaryDirectories = [];
function createBuildFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-web-js-budget-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "server/app"), { recursive: true });
  mkdirSync(join(root, "static/chunks"), { recursive: true });
  writeFileSync(join(root, "prerender-manifest.json"), JSON.stringify({ routes: { "/": {}, "/login": {} } }));
  for (const name of ["shared", "chat", "login", "unrelated"]) writeFileSync(join(root, `static/chunks/${name}.js`), name.repeat(100));
  for (const [page, chunk] of [["index", "chat"], ["login", "login"]]) writeFileSync(join(root, `server/app/${page}.html`),
    `<script src="/_next/static/chunks/shared.js"></script><script src="/_next/static/chunks/${chunk}.js"></script><script src="/_next/static/chunks/shared.js"></script>`);
  return root;
}
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe("entry-script JavaScript budget", () => {
  it("counts each rendered script once and excludes unrelated client-reference modules", () => {
    const results = measureInitialJs(createBuildFixture());
    expect(results.map(result => result.route)).toEqual(["/", "/login"]);
    expect(results.map(result => result.chunkCount)).toEqual([2, 2]);
    expect(results[1].chunks).toEqual(["static/chunks/shared.js", "static/chunks/login.js"]);
    expect(results[1].rawBytes).toBe(1100);
  });
  it("uses HTML semantics rather than matching fake tags in inline scripts and comments", () => {
    expect(entryScriptChunks(`<script>const example = '<script src="/_next/static/chunks/fake.js">';</script><!-- <script src="/_next/static/chunks/comment.js"> --><script src="/_next/static/chunks/real.js?v=1&amp;x=2"></script>`, "/login"))
      .toEqual(["static/chunks/real.js"]);
  });
  it("fails closed for missing routes, HTML, chunks, empty scripts and unsupported sources", () => {
    let root = createBuildFixture();
    unlinkSync(join(root, "static/chunks/login.js"));
    expect(() => measureInitialJs(root)).toThrow("missing or invalid chunk");
    root = createBuildFixture();
    unlinkSync(join(root, "server/app/login.html"));
    expect(() => measureInitialJs(root)).toThrow();
    root = createBuildFixture();
    writeFileSync(join(root, "prerender-manifest.json"), JSON.stringify({ routes: { "/": {} } }));
    expect(() => measureInitialJs(root)).toThrow("no longer prerendered");
    expect(() => entryScriptChunks("<script>inline()</script>", "/")).toThrow("no rendered entry scripts");
    for (const src of ["https://external.example/app.js", "/untracked.js", "/_next/static/%2e%2e/secret.js"]) {
      expect(() => entryScriptChunks(`<script src="${src}"></script>`, "/")).toThrow();
    }
  });
  it("keeps the HTML entry gate at 1800/550 KiB while budgeting hydrated imports separately", () => {
    const entry = javascriptBudget("entry", {});
    const hydrated = javascriptBudget("hydrated", {});
    expect(entry).toEqual({ rawBytes: 1800 * 1024, gzipBytes: 550 * 1024 });
    expect(hydrated).toEqual({ rawBytes: 2100 * 1024, gzipBytes: 675 * 1024 });
    // Actual hydrated fixture measurement includes the pre-existing refractor
    // async chunk; it must not be compared with the HTML-only entry gate.
    const response = [{ route: "/", rawBytes: 2011828, gzipBytes: 637833 }];
    expect(budgetFailures(response, hydrated.rawBytes, hydrated.gzipBytes)).toEqual([]);
    expect(budgetFailures(response, entry.rawBytes, entry.gzipBytes)).toHaveLength(2);
    expect(budgetFailures([{ route: "/", rawBytes: entry.rawBytes + 1, gzipBytes: entry.gzipBytes + 1 }])).toHaveLength(2);
  });
  it("isolates scope overrides and fails closed on invalid budget policies", () => {
    expect(javascriptBudget("entry", { PIWEB_MAX_HYDRATED_JS_KB: "9999", PIWEB_MAX_HYDRATED_JS_GZIP_KB: "9999" }))
      .toEqual(javascriptBudget("entry", {}));
    expect(javascriptBudget("hydrated", { PIWEB_MAX_INITIAL_JS_KB: "9999", PIWEB_MAX_INITIAL_JS_GZIP_KB: "9999" }))
      .toEqual(javascriptBudget("hydrated", {}));
    for (const value of ["0", "-1", "Infinity", "not-a-number", ""]) {
      expect(() => javascriptBudget("entry", { PIWEB_MAX_INITIAL_JS_KB: value })).toThrow("positive numbers");
      expect(() => javascriptBudget("hydrated", { PIWEB_MAX_HYDRATED_JS_GZIP_KB: value })).toThrow("positive numbers");
    }
    expect(() => javascriptBudget("unknown", {})).toThrow("measurement scope");
  });
  it("reports route-specific raw and gzip budget failures and rejects invalid limits", () => {
    expect(budgetFailures([{ route: "/", rawBytes: 2000, gzipBytes: 900 }, { route: "/login", rawBytes: 500, gzipBytes: 200 }], 1000, 800))
      .toEqual(["/ raw 2.0 KB > 1.0 KB", "/ gzip 0.9 KB > 0.8 KB"]);
    expect(() => budgetFailures([], NaN, 800)).toThrow("positive numbers");
  });
});
