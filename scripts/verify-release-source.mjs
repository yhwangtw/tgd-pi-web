import { appendFileSync } from "node:fs";
import { checkCI, command, repositoryName, validateTag, verifiedSource } from "./release-policy.mjs";

try {
  const repository = repositoryName(process.env.GITHUB_REPOSITORY ?? "");
  const git = (args) => command("git", args);
  // Validate syntax before using the tag as a ref. Historical tags are never rewritten.
  const tag = validateTag(process.env.RELEASE_TAG ?? "", { existing: true });
  const existing = git(["tag", "--list", tag]) === tag;
  validateTag(tag, { existing });
  if (process.env.GITHUB_EVENT_NAME === "push" && !existing) throw new Error("Pushed tag is missing.");
  const target = git(["rev-parse", "--verify", `${existing ? `refs/tags/${tag}` : "HEAD"}^{commit}`]);
  const source = verifiedSource(git, target, { expectedSha: process.env.EXPECTED_SHA, tag, existing });
  const ci = checkCI(repository, source);
  const outputs = { tag, version: tag.slice(1), source_sha: target, ci_sha: source, ci_run_id: ci.runId, ci_url: ci.url };
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required in the release workflow.");
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
  console.log(`Verified ${tag}: source ${target}; CI ${ci.url} at ${source}.`);
} catch (error) {
  console.error(`Release stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
