import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

export const REQUIRED_CI_JOBS = ["Lint & Typecheck", "Test", "Build", "Security Audit"];
export const DEFERRED_CI_JOBS = ["E2E", "Archive and offline setup (macos-latest)"];
const VERSION_FILES = ["package-lock.json", "package.json"];

export function command(executable, args, cwd = process.cwd()) {
  return execFileSync(executable, args, {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function ghJson(endpoint, { paginate = false } = {}) {
  const args = ["api", "--hostname", "github.com", endpoint];
  if (paginate) args.push("--paginate", "--slurp");
  return JSON.parse(command("gh", args));
}

export function repositoryName(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("Expected a GitHub owner/repository.");
  return value;
}

export function repositoryFromOrigin(remote) {
  const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/);
  if (!match) throw new Error("origin must identify a github.com repository; no implicit repository fallback.");
  return repositoryName(match[1].replace(/\.git$/, ""));
}

export function utcTag(now = new Date()) {
  return `v${now.toISOString().slice(0, 10).replaceAll("-", ".")}`;
}

export function validateTag(input, { now = new Date(), existing = false } = {}) {
  const tag = input.startsWith("v") ? input : `v${input}`;
  const match = tag.match(/^v(\d{4})\.(\d{2})\.(\d{2})(?:-([1-9]\d*))?$/);
  if (!match) throw new Error("Expected vYYYY.MM.DD or vYYYY.MM.DD-1 (UTC).");
  const [, year, month, day, sequence] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || utcTag(parsed) !== tag.slice(0, 11)
    || (sequence && !Number.isSafeInteger(Number(sequence)))) throw new Error(`Invalid calendar tag: ${tag}`);
  const today = utcTag(now);
  if (tag.slice(0, 11) > today) throw new Error(`Future release date: ${tag}; today is ${today}.`);
  if (!existing && tag.slice(0, 11) !== today) throw new Error(`New releases must use today's UTC date: ${today}.`);
  return tag;
}

export function requireSha(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected a full commit SHA.");
  return sha;
}

function latestSuccessfulRun(matching, label) {
  matching.sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0)
    || b.id - a.id || b.run_attempt - a.run_attempt);
  const run = matching[0];
  if (!run) throw new Error(`No CI run for ${label}.`);
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(`Latest CI run ${run.id} is ${run.conclusion ?? run.status}; not releasing ${label}.`);
  }
  if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error("Invalid CI run identity.");
  return run;
}

export function selectCIRun(runs, repository, sha, workflowId) {
  return latestSuccessfulRun(runs.filter((run) => run.workflow_id === workflowId
    && run.head_sha === sha && run.head_branch === "main"
    && ["push", "workflow_dispatch"].includes(run.event)
    && run.repository?.full_name?.toLowerCase() === repository.toLowerCase()
    && run.head_repository?.full_name?.toLowerCase() === repository.toLowerCase()), `${repository} main at ${sha}`);
}

export function requireCIJobs(jobs, run, required = REQUIRED_CI_JOBS) {
  const valid = jobs.filter((job) => job.run_id === run.id && job.head_sha === run.head_sha);
  for (const name of required) {
    const matches = valid.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      throw new Error(`CI ${run.id}: required job "${name}" is missing, skipped, ambiguous, or unsuccessful.`);
    }
  }
}

function readJobs(prefix, run, api) {
  return api(`${prefix}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, { paginate: true }).flatMap((page) => page.jobs);
}

function assertRunUnchanged(prefix, run, api) {
  const refreshed = api(`${prefix}/runs/${run.id}`);
  if (refreshed.head_sha !== run.head_sha || refreshed.run_attempt !== run.run_attempt
    || refreshed.status !== "completed" || refreshed.conclusion !== "success") {
    throw new Error("CI changed during verification; retry after it completes.");
  }
}

function checkPRCI(repository, sha, workflowId, api) {
  const recovery = "Run the full CI workflow manually on this main commit before releasing.";
  const prefix = `repos/${repository}`;
  const pulls = api(`${prefix}/commits/${sha}/pulls?per_page=100`, { paginate: true }).flat();
  const matching = pulls.filter((pr) => pr.merged_at && pr.merge_commit_sha === sha
    && pr.base?.ref === "main" && pr.base?.repo?.full_name?.toLowerCase() === repository.toLowerCase());
  if (matching.length !== 1) throw new Error(`No unique merged PR for ${sha}. ${recovery}`);
  const pr = matching[0];
  if (!Number.isSafeInteger(pr.number) || pr.number < 1 || !pr.head?.ref) throw new Error("Invalid merged PR identity.");
  const headSha = requireSha(pr.head.sha);
  const headRepo = repositoryName(pr.head.repo?.full_name ?? "");
  const source = api(`${prefix}/git/commits/${sha}`);
  const head = api(`repos/${headRepo}/git/commits/${headSha}`);
  if (source.sha !== sha || head.sha !== headSha
    || requireSha(source.tree?.sha) !== requireSha(head.tree?.sha)) {
    throw new Error(`Merged source differs from PR #${pr.number}'s tested tree. ${recovery}`);
  }
  const actions = `${prefix}/actions`;
  const pages = api(`${actions}/workflows/${workflowId}/runs?head_sha=${headSha}&per_page=100`, { paginate: true });
  const run = latestSuccessfulRun(pages.flatMap((page) => page.workflow_runs).filter((candidate) =>
    candidate.workflow_id === workflowId && candidate.event === "pull_request"
    && candidate.head_sha === headSha && candidate.head_branch === pr.head.ref
    && candidate.repository?.full_name?.toLowerCase() === repository.toLowerCase()
    && candidate.head_repository?.full_name?.toLowerCase() === headRepo.toLowerCase()),
  `PR #${pr.number} at ${headSha}. ${recovery}`);
  requireCIJobs(readJobs(actions, run, api), run, [...REQUIRED_CI_JOBS, ...DEFERRED_CI_JOBS]);
  assertRunUnchanged(actions, run, api);
  return { number: pr.number, sha: headSha, runId: run.id, attempt: run.run_attempt,
    url: `https://github.com/${repository}/actions/runs/${run.id}` };
}

export function checkCI(repository, sha, api = ghJson) {
  repositoryName(repository);
  requireSha(sha);
  const prefix = `repos/${repository}/actions`;
  const workflow = api(`${prefix}/workflows/ci.yml`);
  if (!Number.isSafeInteger(workflow.id) || workflow.path !== ".github/workflows/ci.yml") throw new Error("Could not resolve the canonical CI workflow.");
  // Never filter to success: a later failure/re-run invalidates old green evidence.
  const pages = api(`${prefix}/workflows/${workflow.id}/runs?head_sha=${sha}&per_page=100`, { paginate: true });
  const run = selectCIRun(pages.flatMap((page) => page.workflow_runs), repository, sha, workflow.id);
  const jobs = readJobs(prefix, run, api);
  requireCIJobs(jobs, run);
  // A full manual main run (or a historical full run) is sufficient itself.
  // Fast main runs must inherit the omitted checks from the same source tree.
  const fullMain = DEFERRED_CI_JOBS.every((name) => {
    const matches = jobs.filter((job) => job.name === name && job.run_id === run.id && job.head_sha === sha);
    return matches.length === 1 && matches[0].status === "completed" && matches[0].conclusion === "success";
  });
  const pr = fullMain ? undefined : checkPRCI(repository, sha, workflow.id, api);
  assertRunUnchanged(prefix, run, api);
  return { sha, runId: run.id, attempt: run.run_attempt, url: `https://github.com/${repository}/actions/runs/${run.id}`, ...(pr ? { pr } : {}) };
}

function withoutReleaseVersion(document, isLock) {
  const copy = structuredClone(document);
  delete copy.version;
  if (isLock) delete copy.packages[""].version;
  return copy;
}

export function releaseVersions(git, sha) {
  const pkg = JSON.parse(git(["show", `${sha}:package.json`]));
  const lock = JSON.parse(git(["show", `${sha}:package-lock.json`]));
  if (typeof pkg.version !== "string" || pkg.version !== lock.version || pkg.version !== lock.packages?.[""]?.version) {
    throw new Error(`Package and lockfile versions disagree at ${sha}.`);
  }
  return { pkg, lock, version: pkg.version };
}

export function isVersionOnlyCommit(git, sha, parent) {
  const changed = git(["diff-tree", "--no-commit-id", "--name-only", "-r", parent, sha]).split("\n").filter(Boolean).sort();
  if (!isDeepStrictEqual(changed, VERSION_FILES)) return false;
  if (git(["diff", "--summary", parent, sha, "--", ...VERSION_FILES])) return false;
  const before = releaseVersions(git, parent);
  const after = releaseVersions(git, sha);
  return before.version !== after.version
    && isDeepStrictEqual(withoutReleaseVersion(before.pkg, false), withoutReleaseVersion(after.pkg, false))
    && isDeepStrictEqual(withoutReleaseVersion(before.lock, true), withoutReleaseVersion(after.lock, true));
}

export function verifiedSource(git, target, { expectedSha, tag, existing }) {
  requireSha(target);
  if (expectedSha && requireSha(expectedSha) !== target) throw new Error("main/tag moved since preflight; review the new commit before releasing.");
  git(["merge-base", "--is-ancestor", target, "origin/main"]);
  const current = releaseVersions(git, target);
  if (existing && current.version !== tag.slice(1)) throw new Error("Tag does not match all package version fields.");
  // [skip ci] is NOT evidence. Only exact version-only commits may inherit CI.
  let source = target;
  for (let depth = 0; depth < 32; depth++) {
    const parents = git(["show", "-s", "--format=%P", source]).split(" ").filter(Boolean);
    if (parents.length !== 1 || !isVersionOnlyCommit(git, source, parents[0])) return source;
    source = parents[0];
  }
  throw new Error("Too many consecutive version commits; run CI on a reviewed source commit.");
}
