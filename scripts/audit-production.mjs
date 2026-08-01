#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isPatchedBraceExpansion, resolvePiBraceExpansion } from "./patch-pi-brace-expansion.mjs";

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

export function evaluateAudit(report) {
  const vulnerabilities = report?.vulnerabilities ?? {};
  const blocking = [];
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (BLOCKING_SEVERITIES.has(vulnerability.severity)) blocking.push(name);
  }
  return { blocking };
}

function describeVulnerability(name, vulnerability) {
  const advisories = (vulnerability.via ?? [])
    .map((via) => typeof via === "string" ? via : `${via.title ?? via.name ?? "advisory"} (${via.url ?? "no URL"})`)
    .join("; ");
  return `- ${name} [${vulnerability.severity}]: ${advisories}`;
}

function main() {
  let effectiveBraceExpansion;
  try {
    effectiveBraceExpansion = resolvePiBraceExpansion();
  } catch (error) {
    console.error(`Could not resolve Pi's brace-expansion dependency: ${error.message}`);
    process.exit(1);
  }
  if (!isPatchedBraceExpansion(effectiveBraceExpansion.version)) {
    console.error(
      `Pi resolves vulnerable brace-expansion@${effectiveBraceExpansion.version} from ${effectiveBraceExpansion.packageDir}.`,
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

  const result = evaluateAudit(report);
  if (result.blocking.length > 0) {
    console.error("Blocking production vulnerabilities:");
    for (const name of result.blocking) {
      console.error(describeVulnerability(name, report.vulnerabilities[name]));
    }
    process.exit(1);
  }

  console.log(`Pi resolves patched brace-expansion@${effectiveBraceExpansion.version}.`);
  console.log("Production dependency audit passed policy.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
