#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const NEXT_DIR = resolve(process.env.NEXT_DIR ?? ".next");
const RAW_BUDGET = Number(process.env.PIWEB_MAX_INITIAL_JS_KB ?? 1_800) * 1_024;
const GZIP_BUDGET = Number(process.env.PIWEB_MAX_INITIAL_JS_GZIP_KB ?? 550) * 1_024;

export function parseClientReferenceManifest(file, routeKey) {
  const source = readFileSync(file, "utf8");
  const marker = `globalThis.__RSC_MANIFEST[${JSON.stringify(routeKey)}]=`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${file} does not contain route ${routeKey}`);
  return JSON.parse(source.slice(start + marker.length).replace(/;\s*$/, ""));
}

function existingRouteManifests(nextDir) {
  return [
    { route: "/", key: "/page", file: resolve(nextDir, "server/app/page_client-reference-manifest.js") },
    { route: "/login", key: "/login/page", file: resolve(nextDir, "server/app/login/page_client-reference-manifest.js") },
  ].filter(({ file }) => existsSync(file));
}

export function measureInitialJs(nextDir = NEXT_DIR) {
  const buildManifestPath = resolve(nextDir, "build-manifest.json");
  if (!existsSync(buildManifestPath)) throw new Error("Run `npm run build` before the JavaScript budget audit.");
  const buildManifest = JSON.parse(readFileSync(buildManifestPath, "utf8"));
  const shared = [...(buildManifest.rootMainFiles ?? []), ...(buildManifest.polyfillFiles ?? [])];
  const routes = existingRouteManifests(nextDir);
  if (routes.length === 0) throw new Error("No production App Router client-reference manifests were found.");

  return routes.map(({ route, key, file }) => {
    const manifest = parseClientReferenceManifest(file, key);
    const routeChunks = Object.values(manifest.clientModules ?? {})
      .flatMap((module) => Array.isArray(module?.chunks) ? module.chunks : [])
      .filter((chunk) => typeof chunk === "string" && chunk.endsWith(".js"));
    const chunks = [...new Set([...shared, ...routeChunks])];
    const missing = chunks.filter((chunk) => !existsSync(resolve(nextDir, chunk)));
    if (missing.length > 0) throw new Error(`${route} references missing chunks: ${missing.join(", ")}`);
    const files = chunks.map((chunk) => readFileSync(resolve(nextDir, chunk)));
    return {
      route,
      chunkCount: chunks.length,
      rawBytes: chunks.reduce((total, chunk) => total + statSync(resolve(nextDir, chunk)).size, 0),
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
    console.error(`Initial JavaScript budget exceeded:\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log(`Initial JavaScript budget passed (${formatKb(RAW_BUDGET)} raw / ${formatKb(GZIP_BUDGET)} gzip per route).`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
