#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { parse } from "parse5";
import { javascriptBudget } from "./js-budget-policy.mjs";

const NEXT_DIR = resolve(process.env.NEXT_DIR ?? ".next");
const { rawBytes: RAW_BUDGET, gzipBytes: GZIP_BUDGET } = javascriptBudget("entry");

// Webpack client-reference manifests include reachable modules from other
// entries, not the scripts rendered for this route. Audit Next's prerendered
// route HTML instead. Hydrated dynamic requests have separate browser coverage.
export function entryScriptChunks(html, route) {
  const chunks = new Set();
  function visit(node) {
    if (node.tagName === "script") {
      const src = node.attrs.find(attr => attr.name === "src")?.value;
      if (src) {
        const url = new URL(src, "http://piweb.invalid");
        if (url.origin !== "http://piweb.invalid" || !url.pathname.startsWith("/_next/static/") || !url.pathname.endsWith(".js")) {
          throw new Error(`${route} contains an unsupported entry script: ${src}`);
        }
        const chunk = decodeURIComponent(url.pathname.slice("/_next/".length));
        if (chunk.split("/").some(part => part === ".." || part === "." || part.includes("\\"))) {
          throw new Error(`${route} contains an invalid chunk: ${src}`);
        }
        chunks.add(chunk);
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(parse(html));
  if (!chunks.size) throw new Error(`${route} has no rendered entry scripts`);
  return [...chunks];
}

export function measureInitialJs(nextDir = NEXT_DIR) {
  const prerenderPath = resolve(nextDir, "prerender-manifest.json");
  if (!existsSync(prerenderPath)) throw new Error("Run `npm run build` before the JavaScript budget audit.");
  const manifest = JSON.parse(readFileSync(prerenderPath, "utf8"));
  return ["/", "/login"].map(route => {
    if (!manifest.routes?.[route]) throw new Error(`${route} is no longer prerendered; update the entry-script audit before proceeding`);
    const htmlPath = resolve(nextDir, "server/app", route === "/" ? "index.html" : "login.html");
    const chunks = entryScriptChunks(readFileSync(htmlPath, "utf8"), route);
    const files = chunks.map(chunk => {
      const file = resolve(nextDir, chunk);
      if (relative(nextDir, file).startsWith("..") || !existsSync(file)) throw new Error(`${route} references missing or invalid chunk: ${chunk}`);
      return readFileSync(file);
    });
    return {
      route,
      chunkCount: chunks.length,
      chunks,
      rawBytes: files.reduce((total, contents) => total + contents.byteLength, 0),
      gzipBytes: files.reduce((total, contents) => total + gzipSync(contents, { level: 9 }).byteLength, 0),
    };
  });
}

function formatKb(bytes) {
  return `${(bytes / 1_024).toFixed(1)} KB`;
}

export function budgetFailures(results, rawBudget = RAW_BUDGET, gzipBudget = GZIP_BUDGET) {
  if (!Number.isFinite(rawBudget) || rawBudget <= 0 || !Number.isFinite(gzipBudget) || gzipBudget <= 0) {
    throw new Error("JavaScript budget values must be positive numbers.");
  }
  return results.flatMap((result) => {
    const failures = [];
    if (result.rawBytes > rawBudget) failures.push(`${result.route} raw ${formatKb(result.rawBytes)} > ${formatKb(rawBudget)}`);
    if (result.gzipBytes > gzipBudget) failures.push(`${result.route} gzip ${formatKb(result.gzipBytes)} > ${formatKb(gzipBudget)}`);
    return failures;
  });
}

function main() {
  const results = measureInitialJs();
  for (const result of results) {
    console.log(`${result.route}: ${result.chunkCount} chunks · ${formatKb(result.rawBytes)} raw · ${formatKb(result.gzipBytes)} gzip`);
  }
  const failures = budgetFailures(results);
  if (failures.length > 0) {
    console.error(`Entry-script JavaScript budget exceeded:\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log(`Entry-script JavaScript budget passed (${formatKb(RAW_BUDGET)} raw / ${formatKb(GZIP_BUDGET)} gzip per route).`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
