import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { checkCI, command, repositoryFromOrigin, requireSha, utcTag, validateTag, verifiedSource } from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const help = `Usage: bash scripts/release.sh [vYYYY.MM.DD[-N]] [--dispatch]
Default: read-only preflight for today's UTC date; no local build, edits, tag, or push.
--dispatch: request release.yml on main after exact-SHA CI verification.
The workflow rechecks the SHA and CI. A dispatch is not a completed release or deployment.`;

export function main(argv, { run = (exe, args) => command(exe, args, root), api, now = new Date(), log = console.log } = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) { log(help); return; }
  const dispatch = argv.includes("--dispatch");
  const values = argv.filter((arg) => arg !== "--dispatch");
  if (values.length > 1 || argv.filter((arg) => arg === "--dispatch").length > 1 || values.some((arg) => arg.startsWith("-"))) throw new Error(help);
  const tag = validateTag(values[0] ?? utcTag(now), { now });
  const git = (args) => run("git", args);
  const repository = repositoryFromOrigin(git(["remote", "get-url", "origin"]));
  const request = api ?? ((endpoint, { paginate = false } = {}) => JSON.parse(run("gh", [
    "api", "--hostname", "github.com", endpoint, ...(paginate ? ["--paginate", "--slurp"] : []),
  ])));
  const target = requireSha(request(`repos/${repository}/commits/main`).sha);
  const local = git(["rev-parse", "HEAD"]);
  const knownMain = git(["rev-parse", "origin/main"]);
  if (knownMain !== target) throw new Error("Local origin/main is stale. Fetch origin main, inspect it, and retry.");
  if (local !== target) throw new Error("Local HEAD is not the reviewed remote main. Merge through PR/CI first, then use a main checkout.");
  if (git(["status", "--porcelain"])) throw new Error("Checkout has uncommitted files; they are not part of a release. Use a clean main checkout.");
  const source = verifiedSource(git, target, { tag, existing: false });
  const evidence = checkCI(repository, source, request);
  log(`Repository: ${repository}\nTag: ${tag}\nSource: ${target}\nVerified CI: ${evidence.url} (attempt ${evidence.attempt})`);
  if (!dispatch) { log("Preflight passed. Nothing published. Add --dispatch to request the release."); return evidence; }
  run("gh", ["workflow", "run", "release.yml", "--repo", `https://github.com/${repository}`, "--ref", "main",
    "-f", `tag=${tag}`, "-f", `expected_sha=${target}`]);
  log(`Release requested, not yet published. Check https://github.com/${repository}/actions/workflows/release.yml . Production is unchanged.`);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`Release stopped: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
