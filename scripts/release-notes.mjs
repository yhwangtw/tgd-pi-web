#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateTag } from "./release-policy.mjs";

// NUL-delimited fields preserve delimiter-like text, backslashes and Unicode.
export function parseCommitLog(raw) {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2) throw new Error("Malformed commit log");
  const commits = [];
  for (let i = 0; i < fields.length; i += 2) {
    if (!/^[a-f0-9]{7,40}$/.test(fields[i]) || !fields[i + 1]) throw new Error("Malformed commit log");
    commits.push({ hash: fields[i], subject: fields[i + 1] });
  }
  return commits;
}
const markdownText = value => value.replace(/[\\`*_[\]<>]/g, "\\$&");
export function renderReleaseNotes(commits, { version, sourceSha, ciSha, ciUrl, prCiUrl, prNumber, previousTag, repository }) {
  const groups = new Map([["feat", ["✨ Features", []]], ["fix", ["🐛 Bug Fixes", []]], ["docs", ["📝 Documentation", []]], ["refactor", ["♻️ Refactoring", []]], ["chore", ["🔧 Chores", []]], ["other", ["📦 Other Changes", []]]]);
  for (const { hash, subject } of commits) {
    const match = /^(feat|fix|docs|refactor|chore|ci)(?:\([^)]*\))?!?:\s*(.*)$/.exec(subject);
    const category = match?.[1] === "ci" ? "chore" : match?.[1] ?? "other";
    groups.get(category)[1].push(`- ${markdownText(match?.[2] || subject)} (\`${hash}\`)`);
  }
  const lines = [`## tGD-pi-web ${version}`, "", `Source: \`${sourceSha}\` · CI: [${ciSha}](${ciUrl})`];
  if (prCiUrl) lines.push(`PR checks: [#${prNumber}](${prCiUrl}) (matching source tree)`);
  lines.push("", "This is a source release, not a deployment or an npm package.", "");
  for (const [title, entries] of groups.values()) if (entries.length) lines.push(`### ${title}`, ...entries, "");
  if (previousTag) lines.push("---", `**Full Changelog**: https://github.com/${repository}/compare/${previousTag}...${version}`);
  return `${lines.join("\n")}\n`;
}
export function main(env = process.env) {
  const version = validateTag(env.VERSION ?? "", { existing: true });
  let previousTag = "";
  try { previousTag = execFileSync("git", ["describe", "--tags", "--abbrev=0", `${version}^`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* First release uses the latest 30 subjects. */ }
  const range = previousTag ? [`${previousTag}..${version}`] : ["-30", version];
  const raw = execFileSync("git", ["log", "-z", "--format=%h%x00%s", ...range], { encoding: "utf8" });
  writeFileSync("/tmp/release-notes.md", renderReleaseNotes(parseCommitLog(raw), {
    version, sourceSha: env.VERIFIED_SHA, ciSha: env.CI_SHA, ciUrl: env.CI_URL,
    prCiUrl: env.PR_CI_URL, prNumber: env.PR_NUMBER, previousTag, repository: env.GITHUB_REPOSITORY,
  }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
