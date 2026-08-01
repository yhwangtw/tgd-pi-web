#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ALLOWED_ADVISORY = "https://github.com/advisories/GHSA-mh99-v99m-4gvg";
const ALLOWED_PACKAGE = "brace-expansion";
const ALLOWED_VERSION = "5.0.7";
const ALLOWED_NODE = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
const INSTALLED_PACKAGE_JSON = `${ALLOWED_NODE}/package.json`;
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

function installedAllowlistedVersion() {
  try {
    return JSON.parse(readFileSync(INSTALLED_PACKAGE_JSON, "utf8")).version;
  } catch {
    return null;
  }
}

function advisoryAllowed(vulnerability, advisory, installedVersion) {
  return installedVersion === ALLOWED_VERSION
    && vulnerability.name === ALLOWED_PACKAGE
    && advisory.url === ALLOWED_ADVISORY
    && BLOCKING_SEVERITIES.has(advisory.severity)
    && Array.isArray(vulnerability.nodes)
    && vulnerability.nodes.length > 0
    && vulnerability.nodes.every((node) => node === ALLOWED_NODE);
}

function vulnerabilityAllowed(name, vulnerabilities, installedVersion, visiting = new Set()) {
  if (visiting.has(name)) return false;
  const vulnerability = vulnerabilities[name];
  if (!vulnerability) return false;
  const nextVisiting = new Set(visiting).add(name);
  const blockingVia = (vulnerability.via ?? []).filter((via) => (
    typeof via === "string" || BLOCKING_SEVERITIES.has(via.severity)
  ));
  if (blockingVia.length === 0) return false;
  return blockingVia.every((via) => (
    typeof via === "string"
      ? vulnerabilityAllowed(via, vulnerabilities, installedVersion, nextVisiting)
      : advisoryAllowed(vulnerability, via, installedVersion)
  ));
}

export function evaluateAudit(report, installedVersion) {
  const vulnerabilities = report?.vulnerabilities ?? {};
  const ignored = [];
  const blocking = [];
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (!BLOCKING_SEVERITIES.has(vulnerability.severity)) continue;
    if (vulnerabilityAllowed(name, vulnerabilities, installedVersion)) ignored.push(name);
    else blocking.push(name);
  }
  return { ignored, blocking };
}

function describeVulnerability(name, vulnerability) {
  const advisories = (vulnerability.via ?? [])
    .map((via) => typeof via === "string" ? via : `${via.title ?? via.name ?? "advisory"} (${via.url ?? "no URL"})`)
    .join("; ");
  return `- ${name} [${vulnerability.severity}]: ${advisories}`;
}

function main() {
  const installedVersion = installedAllowlistedVersion();
  if (installedVersion !== ALLOWED_VERSION) {
    console.error(
      `Security allowlist is stale: expected ${ALLOWED_PACKAGE}@${ALLOWED_VERSION} at ${ALLOWED_NODE}, found ${installedVersion ?? "nothing"}. Remove or update the exception.`,
    );
    process.exit(1);
  }

  const audit = spawnSync("npm", ["audit", "--omit=dev", "--audit-level=high", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (audit.error || (audit.status !== 0 && audit.status !== 1)) {
    console.error(`npm audit failed to run${audit.error ? `: ${audit.error.message}` : ` (exit ${audit.status})`}.`);
    if (audit.stderr) console.error(audit.stderr.trim());
    process.exit(1);
  }
  let report;
  try {
    if (typeof audit.stdout !== "string" || audit.stdout.trim() === "") throw new Error("empty output");
    report = JSON.parse(audit.stdout);
    if (report?.auditReportVersion !== 2 || typeof report.vulnerabilities !== "object") {
      throw new Error("unexpected report shape");
    }
  } catch {
    console.error("npm audit did not return valid JSON.");
    if (audit.stderr) console.error(audit.stderr.trim());
    if (audit.stdout) console.error(audit.stdout.trim());
    process.exit(1);
  }

  const result = evaluateAudit(report, installedVersion);
  if (result.blocking.length > 0) {
    console.error("Blocking production vulnerabilities:");
    for (const name of result.blocking) {
      console.error(describeVulnerability(name, report.vulnerabilities[name]));
    }
    process.exit(1);
  }

  if (result.ignored.length > 0) {
    console.warn(
      `Temporarily allowing ${ALLOWED_ADVISORY} from official Pi shrinkwrap (${result.ignored.join(", ")}). All other high/critical findings remain blocking.`,
    );
  }
  console.log("Production dependency audit passed policy.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
