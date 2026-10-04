import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHtmlPreview } from "../html-preview";
import { isolatedPreviewDocument } from "../preview-policy";

describe("HTML preview resource bundle", () => {
  let parent: string;
  let root: string;
  beforeEach(async () => { parent = await mkdtemp(path.join(os.tmpdir(), "pi-html-preview-")); root = path.join(parent, "project"); await mkdir(path.join(root, "assets"), { recursive: true }); });
  afterEach(async () => { await rm(parent, { recursive: true, force: true }); });
  const put = async (name: string, value: string) => { await writeFile(path.join(root, name), value); };
  const bundle = () => buildHtmlPreview(path.join(root, "index.html"), new Set([root]));
  it("bundles styles, CSS imports, images and scripts without exposing same-origin access", async () => {
    await put("index.html", '<link rel="stylesheet" href="assets/main.css"><img src="assets/圖 片.svg"><script src="assets/main.js"></script>');
    await put("assets/main.css", '@import "theme.css"; body{background:url("圖 片.svg")}');
    await put("assets/theme.css", "h1{color:rgb(1,2,3)}");
    await put("assets/圖 片.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await put("assets/main.js", 'document.body.dataset.ready="yes";');
    const result = await bundle();
    expect(result.warnings).toEqual([]);
    expect(result.html).toContain("data:text/css;base64,");
    expect(result.html).toContain("data:image/svg+xml;base64,");
    expect(result.html).toContain("data:text/javascript;base64,");
    const css = Buffer.from(result.html.match(/href="data:text\/css;base64,([^"]+)/)![1], "base64").toString();
    expect(css).toContain("h1{color:rgb(1,2,3)}");
    expect(css).toContain("url(\"data:image/svg+xml;base64,");
    const isolated = isolatedPreviewDocument(result.html, true);
    expect(isolated).toContain("connect-src 'none'");
    expect(isolated).toContain("script-src 'unsafe-inline' data:");
    expect(isolated).not.toContain("allow-same-origin");
    await put("assets/main.js", 'document.body.dataset.ready="updated";');
    expect((await bundle()).revision).not.toBe(result.revision);
  });
  it("includes local ES module graphs, including cyclic imports", async () => {
    await put("index.html", '<script type="module" src="assets/a.js"></script>');
    await put("assets/a.js", 'import { b } from "./b.js"; export const a=1; document.body.dataset.b=b;');
    await put("assets/b.js", 'import "./a.js"; export const b=2;');
    const result = await bundle();
    expect(result.warnings).toEqual([]);
    const imports = JSON.parse(result.html.match(/<script type="importmap">([^<]+)/)![1]).imports;
    expect(Object.keys(imports)).toHaveLength(2);
    expect(Buffer.from(imports["pi-preview-module-0"].split(",")[1], "base64").toString()).toContain('from "pi-preview-module-1"');
  });
  it("preserves inline style identity without letting imported CSS inject HTML", async () => {
    await put("index.html", '<style id="theme" media="screen">@import "assets/main.css";</style><h1>Safe</h1>');
    await put("assets/main.css", 'h1::after{content:"</style><script>bad()</script>"}');
    const result = await bundle();
    expect(result.html).toContain('<style id="theme" media="screen">');
    expect(result.html.match(/<\/style>/gi)).toHaveLength(1);
    expect(result.html).not.toContain('</style><script>');
  });
  it("never bundles outside files, symlinks, or non-asset files", async () => {
    await writeFile(path.join(parent, "outside.js"), 'const SECRET_OUTSIDE="private"');
    await symlink(path.join(parent, "outside.js"), path.join(root, "assets/link.js"));
    await put(".env", "SECRET_ENV=private");
    await put("index.html", '<script src="../outside.js"></script><script src="assets/link.js"></script><img src=".env"><img src="https://invalid.test/remote.png">');
    const result = await bundle();
    expect(result.warnings).toEqual(expect.arrayContaining(["../outside.js", "assets/link.js", ".env", "https://invalid.test/remote.png"]));
    expect(result.html).not.toContain(Buffer.from('const SECRET_OUTSIDE="private"').toString("base64"));
    expect(result.html).not.toContain(Buffer.from("SECRET_ENV=private").toString("base64"));
    await rm(path.join(root, "index.html"));
    await symlink(path.join(parent, "outside.js"), path.join(root, "index.html"));
    await expect(bundle()).rejects.toMatchObject({ status: 403 });
  });
  it("reports a missing entry and missing assets separately", async () => {
    await expect(bundle()).rejects.toMatchObject({ code: "ENOENT" });
    await put("index.html", '<h1>Available</h1><link rel="stylesheet" href="missing.css">');
    const result = await bundle();
    expect(result.html).toContain("Available");
    expect(result.warnings).toContain("missing.css");
  });
});
