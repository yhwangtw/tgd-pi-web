#!/usr/bin/env node

// Pi 0.83.0 ships an npm-shrinkwrap that pins vulnerable brace-expansion 5.0.7
// (GHSA-mh99-v99m-4gvg). Remove only that nested copy so Pi's minimatch
// resolves the project's explicit patched dependency. Delete this workaround
// once the upstream Pi package ships a patched shrinkwrap.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readPackageVersion(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
}

function findPackageDir(entryPath, packageName) {
  let current = dirname(entryPath);
  while (true) {
    const packageJson = join(current, "package.json");
    if (existsSync(packageJson)) {
      const candidate = JSON.parse(readFileSync(packageJson, "utf8"));
      if (candidate.name === packageName) return current;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not locate ${packageName} from ${entryPath}`);
    current = parent;
  }
}

export function isPatchedBraceExpansion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  if (!match) return false;
  const [, majorText, minorText, patchText] = match;
  const [major, minor, patch] = [majorText, minorText, patchText].map(Number);
  return major > 5 || (major === 5 && (minor > 0 || patch >= 8));
}

export function resolvePiBraceExpansion(projectRoot = PROJECT_ROOT) {
  const piMinimatchPackage = join(
    projectRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "minimatch",
    "package.json",
  );
  const requireFromPiMinimatch = createRequire(piMinimatchPackage);
  const entryPath = requireFromPiMinimatch.resolve("brace-expansion");
  const packageDir = findPackageDir(entryPath, "brace-expansion");
  return { packageDir, version: readPackageVersion(packageDir) };
}

export function normalizePiBraceExpansionLock(projectRoot = PROJECT_ROOT) {
  const lockPath = join(projectRoot, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const rootKey = "node_modules/brace-expansion";
  const nestedKey = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
  const rootEntry = lock.packages?.[rootKey];
  if (!rootEntry || !isPatchedBraceExpansion(rootEntry.version)) {
    throw new Error(`package-lock.json does not contain a patched direct brace-expansion dependency`);
  }
  if (JSON.stringify(lock.packages[nestedKey]) !== JSON.stringify(rootEntry)) {
    lock.packages[nestedKey] = { ...rootEntry };
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`Normalized Pi's shrinkwrap lock entry to brace-expansion@${rootEntry.version}.`);
  }
}

export function patchPiBraceExpansion(projectRoot = PROJECT_ROOT) {
  const nestedPackageDir = join(
    projectRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "brace-expansion",
  );

  if (existsSync(nestedPackageDir)) {
    const nestedVersion = readPackageVersion(nestedPackageDir);
    if (!isPatchedBraceExpansion(nestedVersion)) {
      rmSync(nestedPackageDir, { recursive: true, force: true });
      console.log(`Removed Pi's vulnerable brace-expansion@${nestedVersion} shrinkwrap copy.`);
    }
  }

  const effective = resolvePiBraceExpansion(projectRoot);
  if (!isPatchedBraceExpansion(effective.version)) {
    throw new Error(
      `Pi still resolves vulnerable brace-expansion@${effective.version} from ${effective.packageDir}`,
    );
  }
  normalizePiBraceExpansionLock(projectRoot);
  console.log(`Pi resolves patched brace-expansion@${effective.version}.`);
  return effective;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  patchPiBraceExpansion();
}
