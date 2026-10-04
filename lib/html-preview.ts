import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import postcss from "postcss";
import { init, parse as parseImports } from "es-module-lexer";
import { isPathAllowed } from "./file-security";
import { confinedFile, FileOperationError, contentDigest } from "./versioned-file";
import { getImageMime, getAudioMime, getVideoMime } from "./file-mime";

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];
export interface HtmlPreviewBundle { html: string; revision: string; warnings: string[]; }
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_RESOURCES = 100;
const attr = (node: Element, name: string) => node.attrs.find((value) => value.name === name)?.value;
function setAttr(node: Element, name: string, value: string) {
  const existing = node.attrs.find((item) => item.name === name);
  if (existing) existing.value = value;
  else node.attrs.push({ name, value });
}
function setText(node: Element, value: string) { node.childNodes = [{ nodeName: "#text", value, parentNode: node }]; }
function text(node: Element) { return node.childNodes.map((child) => "value" in child ? child.value : "").join(""); }

/** Assemble local assets without granting the iframe access to the host or its APIs. */
export async function buildHtmlPreview(filePath: string, roots: Set<string>): Promise<HtmlPreviewBundle> {
  const allowedRoot = [...roots].filter((root) => isPathAllowed(filePath, new Set([root]))).sort((a, b) => b.length - a.length)[0];
  if (!allowedRoot) throw new FileOperationError("Access denied", 403);
  const root = await fs.realpath(allowedRoot);
  const entry = await confinedFile(root, path.relative(allowedRoot, filePath));
  const warnings = new Set<string>();
  const files = new Map<string, Buffer>();
  const moduleIds = new Map<string, string>();
  const modules: Record<string, string> = {};
  let total = 0;
  let embeddedBytes = 0;
  const warn = (reference: string) => { if (warnings.size < 20) warnings.add(reference); };
  function dataUrl(mime: string, value: string | Buffer): string {
    const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.length;
    embeddedBytes += Math.ceil(bytes / 3) * 4;
    if (embeddedBytes > MAX_TOTAL_BYTES * 2) throw new FileOperationError("Preview resources are too large", 413);
    return `data:${mime};base64,${Buffer.from(value).toString("base64")}`;
  }

  async function read(target: string): Promise<Buffer> {
    const cached = files.get(target);
    if (cached) return cached;
    if (files.size >= MAX_RESOURCES) throw new FileOperationError("Preview has too many local resources", 413);
    const relative = path.relative(root, target);
    const confined = await confinedFile(root, relative);
    const handle = await fs.open(confined, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new FileOperationError("Not a regular file", 400);
      if (before.size > MAX_FILE_BYTES || total + before.size > MAX_TOTAL_BYTES) throw new FileOperationError("Preview resources are too large", 413);
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      const stamp = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
      await confinedFile(root, relative);
      if (stamp(before) !== stamp(after) || stamp(after) !== stamp(await fs.lstat(confined)) || length !== before.size) throw new FileOperationError("File changed; retry preview", 409);
      const bytes = buffer.subarray(0, length);
      total += length;
      files.set(target, bytes);
      return bytes;
    } finally { await handle.close(); }
  }

  function resolve(reference: string, owner: string): string | null {
    if (!reference || reference.startsWith("#") || /^data:/i.test(reference)) return null;
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) { warn(reference); return null; }
    let value: string;
    try { value = decodeURIComponent(reference.split(/[?#]/, 1)[0]); } catch { warn(reference); return null; }
    if (/[\u0000-\u001f\u007f\\]/.test(value)) { warn(reference); return null; }
    // Root-relative web paths belong to this project, never the machine root.
    const target = value.startsWith("/") ? path.resolve(root, `.${value}`) : path.resolve(path.dirname(owner), value);
    if (!isPathAllowed(target, new Set([root]))) { warn(reference); return null; }
    return target;
  }

  async function safely<T>(reference: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try { return await fn(); } catch { warn(reference); return fallback; }
  }

  async function asset(reference: string, owner: string): Promise<string> {
    const target = resolve(reference, owner);
    if (!target) return reference;
    const mime = getImageMime(target) || getAudioMime(target) || getVideoMime(target)
      || ({ ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf" } as Record<string, string>)[path.extname(target).toLowerCase()];
    if (!mime) { warn(reference); return ""; }
    return safely(reference, async () => dataUrl(mime, await read(target)), "");
  }

  async function css(source: string, owner: string, ancestors = new Set<string>()): Promise<string> {
    if (ancestors.size > 12 || ancestors.has(owner)) { warn(path.relative(root, owner)); return ""; }
    const chain = new Set([...ancestors, owner]);
    const tree = postcss.parse(source, { from: undefined });
    const imports: postcss.AtRule[] = [];
    tree.walkAtRules(/^import$/i, (rule) => { imports.push(rule); });
    for (const rule of imports) {
      const match = rule.params.match(/^(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|"([^"]*)"|'([^']*)')\s*(.*)$/i);
      const reference = match && (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]);
      const target = reference ? resolve(reference.trim(), owner) : null;
      if (target && path.extname(target).toLowerCase() === ".css") {
        const nested = await safely(reference!, async () => css((await read(target)).toString("utf8"), target, chain), "");
        const media = match![6];
        // Preserve ordinary @import media queries. Unsupported layer/supports
        // forms remain blocked by CSP rather than changing their meaning.
        if (/^(?:layer|supports)\b/.test(media)) warn(reference!);
        else { rule.replaceWith(postcss.parse(media ? `@media ${media}{${nested}}` : nested).nodes); continue; }
      } else if (reference) warn(reference);
      rule.remove();
    }
    const declarations: postcss.Declaration[] = [];
    tree.walkDecls((declaration) => { declarations.push(declaration); });
    for (const declaration of declarations) {
      const matches = [...declaration.value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)];
      for (const match of matches.reverse()) {
        const value = await asset((match[1] ?? match[2] ?? match[3]).trim(), owner);
        declaration.value = declaration.value.slice(0, match.index) + `url("${value.replace(/"/g, "%22")}")` + declaration.value.slice(match.index! + match[0].length);
      }
    }
    return tree.toString();
  }

  async function moduleSource(source: string, owner: string): Promise<string> {
    await init;
    const [imports] = parseImports(source);
    for (const item of [...imports].reverse()) {
      if (item.d === -2) continue; // import.meta
      if (!item.n) { warn("Dynamic module import"); continue; }
      const target = resolve(item.n, owner);
      if (!target || !/\.(?:m?js)$/i.test(target)) { warn(item.n); continue; }
      const id = await moduleFile(target);
      const replacement = item.d >= 0 ? JSON.stringify(id) : id;
      source = source.slice(0, item.s) + replacement + source.slice(item.e);
    }
    return source;
  }
  async function moduleFile(target: string): Promise<string> {
    const existing = moduleIds.get(target);
    if (existing) return existing;
    const id = `pi-preview-module-${moduleIds.size}`;
    moduleIds.set(target, id); // Reserve before recursion to support cycles.
    modules[id] = dataUrl("text/javascript", await moduleSource((await read(target)).toString("utf8"), target));
    return id;
  }

  const document = parse((await read(entry)).toString("utf8"));
  async function visit(node: Node): Promise<void> {
    if (!("childNodes" in node)) return;
    for (const child of [...node.childNodes]) {
      if (!("tagName" in child)) continue;
      const tag = child.tagName;
      if (tag === "base" || (tag === "meta" && /^(?:refresh|content-security-policy)$/i.test(attr(child, "http-equiv") ?? ""))) {
        node.childNodes.splice(node.childNodes.indexOf(child), 1); continue;
      }
      if (tag === "script") {
        if (attr(child, "type") === "importmap") { warn("Custom import map"); node.childNodes.splice(node.childNodes.indexOf(child), 1); continue; }
        const reference = attr(child, "src");
        const isModule = attr(child, "type") === "module";
        if (reference) {
          const target = resolve(reference, entry);
          if (target && /\.(?:c?js|mjs)$/i.test(target)) {
            const value = await safely(reference, async () => isModule
              ? modules[await moduleFile(target)] ?? ""
              : dataUrl("text/javascript", await read(target)), "");
            setAttr(child, "src", value);
            child.attrs = child.attrs.filter((item) => !["integrity", "crossorigin"].includes(item.name));
          } else warn(reference);
        } else if (isModule) {
          setAttr(child, "src", dataUrl("text/javascript", await safely("Inline module", () => moduleSource(text(child), entry), "")));
          setText(child, "");
        }
      } else if (tag === "link" && attr(child, "rel")?.toLowerCase() === "stylesheet") {
        const reference = attr(child, "href") ?? "";
        const target = resolve(reference, entry);
        if (target && /\.css$/i.test(target)) {
          const value = await safely(reference, async () => css((await read(target)).toString("utf8"), target), "");
          setAttr(child, "href", dataUrl("text/css", value));
          child.attrs = child.attrs.filter((item) => !["integrity", "crossorigin"].includes(item.name));
        }
      } else if (tag === "style") {
        const value = await safely("Inline stylesheet", () => css(text(child), entry), "");
        // Keep style IDs/media and runtime CSS editing intact. Imported CSS
        // must not be able to terminate this raw-text HTML element.
        setText(child, value.replace(/<\/style/gi, "<\\/style"));
      }
      const inlineStyle = attr(child, "style");
      if (inlineStyle) {
        const value = await safely("Inline style", () => css(`x{${inlineStyle}}`, entry), "x{}");
        setAttr(child, "style", value.slice(value.indexOf("{") + 1, value.lastIndexOf("}")));
      }
      if (["img", "source", "video", "audio", "input"].includes(tag)) {
        for (const name of ["src", "poster"]) {
          const reference = attr(child, name);
          if (reference) setAttr(child, name, await asset(reference, entry));
        }
        const srcset = attr(child, "srcset");
        if (srcset && !srcset.includes("data:")) {
          const values = [];
          for (const candidate of srcset.split(",")) {
            const [url, ...descriptor] = candidate.trim().split(/\s+/);
            values.push([await asset(url, entry), ...descriptor].join(" "));
          }
          setAttr(child, "srcset", values.join(", "));
        }
      }
      await visit(child);
    }
  }
  await visit(document);
  const htmlElement = document.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "html");
  const head = htmlElement?.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "head");
  if (head && Object.keys(modules).length) {
    const map = parse(`<script type="importmap">${JSON.stringify({ imports: modules }).replace(/</g, "\\u003c")}</script>`);
    const mapHtml = map.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "html")!;
    const mapHead = mapHtml.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "head")!;
    for (const child of mapHead.childNodes) { child.parentNode = head; head.childNodes.unshift(child); }
  }
  const html = serialize(document);
  return { html, revision: contentDigest(html), warnings: [...warnings] };
}
