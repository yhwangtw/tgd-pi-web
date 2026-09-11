import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkCI, command, isVersionOnlyCommit, repositoryFromOrigin, REQUIRED_CI_JOBS, requireCIJobs, selectCIRun, utcTag, validateTag, verifiedSource } from "../release-policy.mjs";
import { main } from "../release.mjs";
import { shouldBeLatest } from "../release-latest.mjs";

const now = new Date("2026-09-05T18:00:00Z"); // Taipei is already September 6.
const sha = "a".repeat(40);
const repository = "owner/project";
const run = { id: 80, workflow_id: 7, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", run_attempt: 2, repository: { full_name: repository }, head_repository: { full_name: repository } };
const jobs = () => REQUIRED_CI_JOBS.map((name) => ({ name, run_id: run.id, head_sha: sha, status: "completed", conclusion: "success" }));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function apiFixture({ runs = [run], ciJobs = jobs(), refresh = run } = {}) {
  return vi.fn((endpoint) => {
    if (endpoint.endsWith("/commits/main")) return { sha };
    if (endpoint.endsWith("/workflows/ci.yml")) return { id: 7, path: ".github/workflows/ci.yml" };
    if (endpoint.includes("/workflows/7/runs?")) return [{ workflow_runs: [] }, { workflow_runs: runs }];
    if (endpoint.includes(`/runs/${run.id}/attempts/${run.run_attempt}/jobs?`)) return [{ jobs: ciJobs.slice(0, 2) }, { jobs: ciJobs.slice(2) }];
    if (endpoint.endsWith(`/runs/${run.id}`)) return refresh;
    throw new Error(`Unexpected request: ${endpoint}`);
  });
}

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-release-policy-"));
  roots.push(root);
  const git = (args) => command("git", args, root);
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Release fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "tag.gpgsign", "false"]);
  git(["config", "core.hooksPath", "/dev/null"]);
  const version = (value, extra = {}) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: value, ...extra }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ name: "fixture", version: value, packages: { "": { name: "fixture", version: value }, "node_modules/dep": { version: "1.0.0" } } }));
  };
  const commit = (message) => {
    git(["add", "."]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", message]);
    const id = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", id]);
    return id;
  };
  version("2026.09.04");
  const base = commit("Reviewed code");
  return { root, git, version, commit, base };
}

describe("calendar release policy", () => {
  it("uses UTC, accepts explicit sequence tags, and resumes existing historical tags only", () => {
    expect(utcTag(now)).toBe("v2026.09.05");
    expect(validateTag("2026.09.05-12", { now })).toBe("v2026.09.05-12");
    expect(validateTag("v2024.02.29", { now, existing: true })).toBe("v2024.02.29");
    expect(() => validateTag("v2026.09.04", { now })).toThrow("today's UTC");
  });
  it.each(["v2026.02.30", "v2025.02.29", "v2026.13.01", "v2026.09.05-0", "v2026.09.05-01", "v2026.09.05-9007199254740992", "v2026.09.05\nmalicious", "$(touch /tmp/no)"])("rejects invalid tag %s", (tag) => {
    expect(() => validateTag(tag, { now, existing: true })).toThrow();
  });
  it("never accepts future tags even in recovery", () => expect(() => validateTag("v2026.09.06", { now, existing: true })).toThrow("Future"));
  it("preserves a later date or numeric sequence as latest", () => {
    const releases = [{ tag_name: "v2026.09.05-10" }, { tag_name: "v2026.09.05-11", draft: true }];
    expect(shouldBeLatest("v2026.09.05-9", releases, now)).toBe(false);
    expect(shouldBeLatest("v2026.09.04-20", releases, now)).toBe(false);
    expect(shouldBeLatest("v2026.09.05-11", releases, now)).toBe(true);
    expect(shouldBeLatest("v2026.09.05", [], now)).toBe(true);
    expect(shouldBeLatest("v2026.09.05", [{ tag_name: "v0.6.19" }], now)).toBe(true);
    expect(() => shouldBeLatest("v2026.09.05", [{ tag_name: "unrecognized" }], now)).toThrow();
  });
  it.each(["https://github.com/owner/project.git", "git@github.com:owner/project.git", "ssh://git@github.com/owner/project.git"])("resolves exact origin %s", (remote) => expect(repositoryFromOrigin(remote)).toBe(repository));
  it.each(["https://github.com.evil.invalid/owner/project", "https://token@github.com/owner/project", "/local/project", "https://example.invalid/owner/project"])("does not guess a repository for %s", (remote) => expect(() => repositoryFromOrigin(remote)).toThrow());
});

describe("SHA-bound CI gate", () => {
  it("reads all run/job pages and pins job evidence to the run attempt", () => {
    const api = apiFixture();
    expect(checkCI(repository, sha, api)).toEqual({ sha, runId: 80, attempt: 2, url: "https://github.com/owner/project/actions/runs/80" });
    expect(api.mock.calls[1][1]).toEqual({ paginate: true });
    expect(api.mock.calls[2][0]).toContain("/attempts/2/jobs?");
    expect(api.mock.calls[1][0]).not.toContain("status=success");
  });
  it.each(["queued", "in_progress", "failure", "cancelled", "skipped"])("does not fall back to an old green run after %s", (state) => {
    const latest = { ...run, id: 81, status: state === "queued" || state === "in_progress" ? state : "completed", conclusion: state === "queued" || state === "in_progress" ? null : state };
    expect(() => selectCIRun([run, latest], repository, sha, 7)).toThrow("Latest CI");
  });
  it.each([{ head_sha: "b".repeat(40) }, { head_branch: "feature" }, { event: "pull_request" }, { workflow_id: 8 }, { head_repository: { full_name: "fork/project" } }])("rejects unrelated evidence %j", (change) => {
    expect(() => selectCIRun([{ ...run, ...change }], repository, sha, 7)).toThrow("No CI run");
  });
  it("requires every actual job; skipped or absent jobs do not count", () => {
    expect(() => requireCIJobs(jobs().slice(0, -1), run)).toThrow("Security Audit");
    expect(() => requireCIJobs(jobs().map((job) => ({ ...job, conclusion: "skipped" })), run)).toThrow();
    expect(() => requireCIJobs([...jobs(), jobs()[0]], run)).toThrow("ambiguous");
    expect(() => requireCIJobs(jobs().map((job) => ({ ...job, head_sha: "b".repeat(40) })), run)).toThrow();
  });
  it("also respects a more recently restarted older run", () => {
    expect(() => selectCIRun([
      { ...run, id: 81, updated_at: "2026-09-05T01:00:00Z" },
      { ...run, updated_at: "2026-09-05T02:00:00Z", run_attempt: 3, status: "in_progress", conclusion: null },
    ], repository, sha, 7)).toThrow("Latest CI run 80");
  });
  it("fails closed for API errors and a re-run during verification", () => {
    expect(() => checkCI(repository, sha, () => { throw new Error("HTTP 403"); })).toThrow("HTTP 403");
    expect(() => checkCI(repository, sha, apiFixture({ refresh: { ...run, run_attempt: 3 } }))).toThrow("changed during verification");
  });
});

describe("release source provenance with real Git", () => {
  it("inherits CI only through exact version-only commits without touching checkout state", () => {
    const f = gitFixture();
    f.version("2026.09.05");
    f.commit("chore: release v2026.09.05 [skip ci]");
    f.version("2026.09.05-1");
    const target = f.commit("another release");
    const before = f.git(["status", "--porcelain"]);
    expect(verifiedSource(f.git, target, { expectedSha: target, tag: "v2026.09.05-1", existing: true })).toBe(f.base);
    expect(f.git(["rev-parse", "HEAD"])).toBe(target);
    expect(f.git(["status", "--porcelain"])).toBe(before);
  });
  it("does not treat dependency or executable changes as an untested version bump", () => {
    const f = gitFixture();
    f.version("2026.09.05", { dependencies: { unexpected: "1.0.0" } });
    const target = f.commit("chore: release [skip ci]");
    expect(isVersionOnlyCommit(f.git, target, f.base)).toBe(false);
    expect(verifiedSource(f.git, target, { tag: "v2026.09.05", existing: true })).toBe(target);
    f.version("2026.09.05-1", { dependencies: { unexpected: "1.0.0" } });
    f.git(["update-index", "--chmod=+x", "package.json"]);
    f.git(["-c", "core.filemode=false", "add", "package.json", "package-lock.json"]);
    f.git(["-c", "commit.gpgsign=false", "commit", "-m", "mode change"]);
    expect(isVersionOnlyCommit(f.git, f.git(["rev-parse", "HEAD"]), target)).toBe(false);
  });
  it("blocks changed target, tag/version mismatch, unmerged code, and mismatched lock versions", () => {
    const f = gitFixture();
    expect(() => verifiedSource(f.git, f.base, { expectedSha: sha, existing: false })).toThrow("moved");
    expect(() => verifiedSource(f.git, f.base, { tag: "v2026.09.05", existing: true })).toThrow("Tag does not match");
    f.version("2026.09.05");
    const unmerged = f.commit("feature");
    f.git(["update-ref", "refs/remotes/origin/main", f.base]);
    expect(() => verifiedSource(f.git, unmerged, { tag: "v2026.09.05", existing: true })).toThrow();
    const lock = JSON.parse(readFileSync(join(f.root, "package-lock.json"), "utf8"));
    lock.packages[""].version = "2026.09.03";
    writeFileSync(join(f.root, "package-lock.json"), JSON.stringify(lock));
    const bad = f.commit("bad lock");
    expect(() => verifiedSource(f.git, bad, { tag: "v2026.09.05", existing: true })).toThrow("versions disagree");
  });
});

describe("safe release entrypoint", () => {
  const commands = (overrides = {}) => vi.fn((exe, args) => {
    if (exe === "gh" && args[0] === "workflow") return "requested";
    const key = args.join(" ");
    if (Object.hasOwn(overrides, key)) return overrides[key];
    if (key === "remote get-url origin") return "git@github.com:owner/project.git";
    if (key === "rev-parse HEAD" || key === "rev-parse origin/main") return sha;
    if (args[0] === "show" && args[1].endsWith(":package.json")) return JSON.stringify({ version: "2026.09.04" });
    if (args[0] === "show" && args[1].endsWith(":package-lock.json")) return JSON.stringify({ version: "2026.09.04", packages: { "": { version: "2026.09.04" } } });
    if (key === "status --porcelain" || key === `show -s --format=%P ${sha}` || args[0] === "merge-base") return "";
    throw new Error(`Unexpected command: ${exe} ${key}`);
  });
  it("defaults to read-only UTC preflight with no build, version, tag, fetch or push", () => {
    const execute = commands();
    const log = vi.fn();
    main([], { run: execute, api: apiFixture(), now, log });
    expect(execute.mock.calls.every(([exe]) => exe === "git")).toBe(true);
    expect(log.mock.calls.flat().join("\n")).toContain("v2026.09.05");
    expect(log.mock.calls.flat().join("\n")).toContain("Nothing published");
  });
  it("dispatches only on explicit opt-in, bound to repository/main/SHA", () => {
    const execute = commands();
    main(["--dispatch"], { run: execute, api: apiFixture(), now, log: vi.fn() });
    expect(execute.mock.calls.filter(([exe]) => exe === "gh")).toEqual([["gh", ["workflow", "run", "release.yml", "--repo", "https://github.com/owner/project", "--ref", "main", "-f", "tag=v2026.09.05", "-f", `expected_sha=${sha}`]]]);
  });
  it.each([{ "rev-parse HEAD": "b".repeat(40) }, { "rev-parse origin/main": "b".repeat(40) }, { "status --porcelain": " M README.md" }])("never dispatches unreconciled local state %j", (overrides) => {
    const execute = commands(overrides);
    expect(() => main(["--dispatch"], { run: execute, api: apiFixture(), now, log: vi.fn() })).toThrow();
    expect(execute.mock.calls.some(([exe]) => exe === "gh")).toBe(false);
  });
  it("help and malformed arguments never contact a service", () => {
    const execute = vi.fn();
    main(["--help"], { run: execute, log: vi.fn() });
    expect(() => main(["--unknown"], { run: execute })).toThrow("Usage");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("workflow entrypoint and wiring", () => {
  function prepareScript() {
    const text = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
    const step = text.split("      - name: Prepare release commit and tag\n")[1].split("\n      - name:")[0];
    return step.split("        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  }
  function publicationFixture() {
    const f = gitFixture();
    const remote = mkdtempSync(join(tmpdir(), "pi-release-remote-"));
    roots.push(remote);
    command("git", ["init", "--bare", "-b", "main"], remote);
    f.git(["remote", "add", "origin", remote]);
    f.git(["push", "origin", "main"]);
    const publish = (expected = f.base) => spawnSync("bash", ["-e", "-o", "pipefail"], {
      cwd: f.root, input: prepareScript(), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, TAG: "v2026.09.05", VERSION: "2026.09.05", VERIFIED_SHA: expected },
    });
    return { ...f, remote, publish };
  }
  it("executes the real workflow preparation against a disposable remote and resumes without extra commits", () => {
    const f = publicationFixture();
    const result = f.publish();
    expect(result.status, result.stderr).toBe(0);
    const target = f.git(["rev-parse", "HEAD"]);
    expect(command("git", ["rev-parse", "main"], f.remote)).toBe(target);
    expect(command("git", ["cat-file", "-t", "v2026.09.05"], f.remote)).toBe("tag");
    expect(command("git", ["rev-parse", "v2026.09.05^{commit}"], f.remote)).toBe(target);
    expect(isVersionOnlyCommit(f.git, target, f.base)).toBe(true);
    expect(f.publish(target).status).toBe(0);
    expect(f.git(["rev-parse", "HEAD"])).toBe(target);
  });
  it("fails before versioning when the checked-out source differs from the gate", () => {
    const f = publicationFixture();
    expect(f.publish(sha).status).not.toBe(0);
    expect(f.git(["rev-parse", "HEAD"])).toBe(f.base);
    expect(f.git(["status", "--porcelain"])).toBe("");
    expect(command("git", ["tag", "--list"], f.remote)).toBe("");
  });
  it("an advanced remote main rejects both the commit and tag atomically", () => {
    const f = publicationFixture();
    const tree = f.git(["rev-parse", `${f.base}^{tree}`]);
    const remoteHead = f.git(["commit-tree", tree, "-p", f.base, "-m", "another merged change"]);
    // All Git objects already exist in this disposable repository; send only
    // the concurrent branch advance before attempting the stale release push.
    f.git(["push", "origin", `${remoteHead}:main`]);
    const result = f.publish();
    expect(result.status).not.toBe(0);
    expect(command("git", ["rev-parse", "main"], f.remote)).toBe(remoteHead);
    expect(command("git", ["tag", "--list"], f.remote)).toBe("");
  });
  function verifyFixture({ state = "success", expected = true, existing = false } = {}) {
    const f = gitFixture();
    const tag = utcTag();
    let target = f.base;
    if (existing) {
      f.version(tag.slice(1));
      target = f.commit("version-only release");
      f.git(["tag", "-a", tag, "-m", "fixture"]);
    }
    const fakeBin = join(f.root, "bin");
    mkdirSync(fakeBin);
    const fakeGh = join(fakeBin, "gh");
    const fixtureRun = { ...run, head_sha: f.base, status: "completed", conclusion: state };
    const fixtureJobs = jobs().map((job) => ({ ...job, head_sha: f.base }));
    // Only API GET is implemented. Any dispatch/publication attempt fails.
    writeFileSync(fakeGh, `#!${process.execPath}\nconst args = process.argv.slice(2);
if (args[0] !== 'api') process.exit(90);
const endpoint = args[3];
const run = ${JSON.stringify(fixtureRun)};
let body;
if (endpoint.endsWith('/workflows/ci.yml')) body = {id: 7, path: '.github/workflows/ci.yml'};
else if (endpoint.includes('/workflows/7/runs?')) body = [{workflow_runs: [run]}];
else if (endpoint.includes('/attempts/2/jobs?')) body = [{jobs: ${JSON.stringify(fixtureJobs)}}];
else if (endpoint.endsWith('/runs/80')) body = run;
else process.exit(91);
console.log(JSON.stringify(body));\n`);
    chmodSync(fakeGh, 0o755);
    const output = join(f.root, "outputs");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [resolve("scripts/verify-release-source.mjs")], {
      cwd: f.root, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, GITHUB_REPOSITORY: repository,
        RELEASE_TAG: tag, EXPECTED_SHA: expected ? target : sha, GITHUB_OUTPUT: output,
        GITHUB_EVENT_NAME: existing ? "push" : "workflow_dispatch" },
    });
    return { f, target, result, outputs: readFileSync(output, "utf8") };
  }
  it.each([false, true])("writes verified GitHub outputs for existing=%s without modifying HEAD", (existing) => {
    const { f, target, result, outputs } = verifyFixture({ existing });
    expect(result.status, result.stderr).toBe(0);
    expect(outputs).toContain(`source_sha=${target}\n`);
    expect(outputs).toContain(`ci_sha=${f.base}\n`);
    expect(outputs).toContain("ci_run_id=80\n");
    expect(f.git(["rev-parse", "HEAD"])).toBe(target);
  });
  it.each([{ state: "failure" }, { expected: false }])("writes no successful outputs when verification fails %j", (options) => {
    const { result, outputs } = verifyFixture(options);
    expect(result.status).toBe(1);
    expect(outputs).toBe("");
    expect(result.stderr).toContain("Release stopped");
  });
  it("places the gate before every public write and documents one non-building entrypoint", () => {
    const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
    const gate = workflow.indexOf("run: node scripts/verify-release-source.mjs");
    expect(gate).toBeGreaterThan(0);
    for (const write of ["git commit", "git tag -a", "git push --atomic", "gh release create"]) {
      expect(workflow.indexOf(write)).toBeGreaterThan(gate);
    }
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("ref: main");
    expect(workflow).toContain('run: test "$GITHUB_REF" = refs/heads/main');
    expect(workflow).toContain('--latest="$LATEST"');
    expect(workflow).toContain("node scripts/release-latest.mjs");
    const helper = readFileSync(resolve("scripts/release.sh"), "utf8");
    expect(helper).toContain('exec node "$SCRIPT_DIR/release.mjs" "$@"');
    for (const forbidden of ["npm run build", "git push", "git tag", "Asia/Taipei", "npm install"]) expect(helper).not.toContain(forbidden);
    const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
    for (const name of REQUIRED_CI_JOBS) expect(ci).toContain(`name: ${name}\n`);
    for (const file of ["README.md", "README.zh-TW.md", "README.ja.md", "README.de.md"]) {
      const readme = readFileSync(resolve(file), "utf8");
      expect(readme).toContain("22.19");
      expect(readme).toContain("23.4");
      expect(readme).toContain("TGD_SETUP_FORCE_SYNC=1");
      expect(readme).toContain("bash scripts/release.sh vYYYY.MM.DD --dispatch");
      expect(readme).toContain("./docs/RELEASING.md");
    }
  });
});
