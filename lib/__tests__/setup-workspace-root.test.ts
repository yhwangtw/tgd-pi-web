import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { spawn, spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const LEGACY_FILES = [
  "components/ui/CommandPalette.tsx",
  "components/ui/CommandPalette.module.css",
  "components/sidebar/SearchResults.tsx",
  "components/sidebar/SearchResults.module.css",
] as const;

function runSetupFixture(
  options: {
    gitCheckout?: boolean;
    legacyFiles?: boolean;
    offline?: boolean;
    dirty?: boolean;
    localCommits?: number;
    forceSync?: boolean;
    piVersion?: string;
    tscExit?: number;
    nodeVersion?: string;
    runningCheckout?: boolean;
    legacyRunningCheckout?: boolean;
  } = {},
) {
  const sandbox = mkdtempSync(join(tmpdir(), "tgd-pi-web-setup-"));
  tempDirs.push(sandbox);

  const home = join(sandbox, "home", "user");
  const project = join(home, "tGD-pi-web");
  const fakeBin = join(sandbox, "bin");
  const ancestorLockfile = join(home, "package-lock.json");
  const gitLog = join(sandbox, "git.log");
  const npmLog = join(sandbox, "npm.log");
  const backupRoot = join(sandbox, "backups");

  mkdirSync(project, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(project, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(project, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
  copyFileSync(resolve("setup.sh"), join(project, "setup.sh"));
  for (const file of ["lib/node-support.mjs", "scripts/check-node-version.mjs", "scripts/runtime-guard.mjs", "scripts/check-running-checkout.mjs"]) {
    mkdirSync(dirname(join(project, file)), { recursive: true });
    copyFileSync(resolve(file), join(project, file));
  }
  writeFileSync(join(project, "package-lock.json"), "{}\n");
  writeFileSync(
    join(project, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    JSON.stringify({ version: "0.83.0" }),
  );
  writeFileSync(ancestorLockfile, "{}\n");
  writeFileSync(gitLog, "");
  writeFileSync(npmLog, "");

  const runningFixture = options.runningCheckout || options.legacyRunningCheckout
    ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: project, stdio: "ignore" })
    : null;
  if (runningFixture && !options.legacyRunningCheckout) {
    mkdirSync(join(project, ".piweb-runtime"));
    writeFileSync(join(project, ".piweb-runtime", `${runningFixture.pid}.json`), JSON.stringify({
      pid: runningFixture.pid, childPid: runningFixture.pid, cwd: project,
      startedAt: new Date().toISOString(), mode: "start", host: "127.0.0.1", port: 30141,
    }));
  }

  // The guard fixture must not inspect unrelated developer/CI Next processes.
  // Legacy coverage emits only our disposable timer PID; cwd is still verified
  // by the real platform process reader, not trusted from this fake ps output.
  const fakePs = join(fakeBin, "ps");
  writeFileSync(fakePs, `#!/usr/bin/env bash\n${options.legacyRunningCheckout ? `echo '${runningFixture!.pid} next-server (fixture)'` : "exit 0"}\n`);
  chmodSync(fakePs, 0o755);

  if (options.gitCheckout) {
    mkdirSync(join(project, ".git"));
  }

  if (options.legacyFiles) {
    for (const file of LEGACY_FILES) {
      const target = join(project, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `legacy:${file}\n`);
    }
  }

  const fakeNpm = join(fakeBin, "npm");
  writeFileSync(fakeNpm, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
if [ "$1" = "--version" ]; then
  echo "10.9.0"
fi
exit 0
`);
  chmodSync(fakeNpm, 0o755);

  if (options.nodeVersion) {
    const fakeNode = join(fakeBin, "node");
    writeFileSync(fakeNode, `#!/usr/bin/env bash
if [ "$1" = "-p" ] && [ "$2" = "process.versions.node" ]; then
  echo "${options.nodeVersion}"
  exit 0
fi
exec ${JSON.stringify(process.execPath)} "$@"
`);
    chmodSync(fakeNode, 0o755);
  }

  const fakePi = join(fakeBin, "pi");
  writeFileSync(fakePi, `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "${options.piVersion ?? "0.83.0"}"
fi
exit 0
`);
  chmodSync(fakePi, 0o755);

  const fakeGit = join(fakeBin, "git");
  writeFileSync(fakeGit, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_GIT_LOG"
case "$1 $2" in
  "status --porcelain")
    if [ "${options.dirty ? "1" : "0"}" = "1" ]; then
      echo " M README.md"
    fi
    ;;
  "rev-list --count")
    echo "${options.localCommits ?? 0}"
    ;;
  "status --short")
    if [ "${options.dirty ? "1" : "0"}" = "1" ]; then
      echo " M README.md"
    fi
    ;;
  "rev-parse HEAD") echo "0123456789abcdef" ;;
  "diff --binary") echo "working tree patch" ;;
  "diff --cached") echo "staged patch" ;;
  "log --oneline") echo "local commit" ;;
  "bundle create") : > "$3" ;;
esac
exit 0
`);
  chmodSync(fakeGit, 0o755);

  const fakeTsc = join(project, "node_modules", ".bin", "tsc");
  writeFileSync(fakeTsc, `#!/usr/bin/env bash
if [ "${options.tscExit ?? 0}" -ne 0 ]; then
  echo "TS setup failure" >&2
fi
exit ${options.tscExit ?? 0}
`);
  chmodSync(fakeTsc, 0o755);

  const result = spawnSync("bash", [join(project, "setup.sh")], {
    cwd: dirname(project),
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      FAKE_GIT_LOG: gitLog,
      FAKE_NPM_LOG: npmLog,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      TGD_SETUP_BACKUP_DIR: backupRoot,
      TGD_SETUP_OFFLINE: options.offline ? "1" : "0",
      TGD_SETUP_FORCE_SYNC: options.forceSync ? "1" : "0",
      TGD_SETUP_SOURCE_SYNCED: "0",
    },
  });
  runningFixture?.kill("SIGTERM");

  return {
    ancestorLockfile,
    backupRoot,
    gitCalls: readFileSync(gitLog, "utf8"),
    npmCalls: readFileSync(npmLog, "utf8"),
    project,
    result,
  };
}

describe("workspace root setup", () => {
  it("rejects a legacy unmarked running checkout before any mutation", () => {
    const { result, gitCalls, npmCalls } = runSetupFixture({ gitCheckout: true, legacyRunningCheckout: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checkout is running");
    expect(gitCalls).not.toContain("fetch");
    expect(npmCalls).not.toContain("ci");
  });
  it("refuses a running checkout before fetch, backup, dependency install, or build", () => {
    const { gitCalls, npmCalls, result, backupRoot } = runSetupFixture({ gitCheckout: true, dirty: true, forceSync: true, runningCheckout: true });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("checkout is running");
    expect(gitCalls).toBe("");
    expect(npmCalls).toBe("");
    expect(existsSync(backupRoot)).toBe(false);
  });
  it("rejects unsupported Node before any Git source replacement", () => {
    const { gitCalls, npmCalls, result } = runSetupFixture({ gitCheckout: true, nodeVersion: "22.18.0" });
    expect(result.status).toBe(1);
    expect(gitCalls).toBe("");
    expect(npmCalls).toBe("");
  });

  // Each installation is its own test, not six shell fixtures competing for
  // one five-second deadline when the full suite runs concurrently.
  it.each(["20.19.0", "22.18.0", "23.3.0"])("rejects unsupported Node %s before installing dependencies", nodeVersion => {
    const { npmCalls, result } = runSetupFixture({ nodeVersion });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("22.19+");
    expect(npmCalls).not.toContain("ci");
  });
  it.each(["22.19.0", "23.4.0", "24.0.0"])("accepts supported Node version declaration %s", nodeVersion => {
    expect(runSetupFixture({ nodeVersion }).result.status).toBe(0);
  });

  it("pins Next.js tracing and Turbopack to the repository root", () => {
    const repositoryRoot = resolve(__dirname, "../..");

    expect(nextConfig).toMatchObject({
      outputFileTracingRoot: repositoryRoot,
      turbopack: { root: repositoryRoot },
    });
  });

  it("warns about an ancestor lockfile without modifying it", () => {
    const { ancestorLockfile, result } = runSetupFixture();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("偵測到上層 lockfile");
    expect(result.stdout).toContain(ancestorLockfile);
    expect(existsSync(ancestorLockfile)).toBe(true);
  });

  it("builds production during setup and never invokes dev", () => {
    const { npmCalls, result } = runSetupFixture();

    expect(result.status).toBe(0);
    expect(npmCalls).toContain("run build");
    expect(npmCalls).not.toContain("run dev");
    expect(result.stdout).toContain("Production build 完成");
    expect(result.stdout).not.toContain("啟動開發模式");
  });

  it("reports a matching global Pi CLI without reinstalling it", () => {
    const { npmCalls, result } = runSetupFixture({ piVersion: "0.83.0" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("全域 Pi CLI 版本一致: 0.83.0");
    expect(npmCalls).not.toContain("install -g");
  });

  it("warns about a mismatched global Pi CLI without changing it non-interactively", () => {
    const { npmCalls, result } = runSetupFixture({ piVersion: "0.79.3" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("全域 Pi CLI 0.79.3 與 Web runtime 0.83.0 不一致");
    expect(result.stdout).toContain("npm install -g @earendil-works/pi-coding-agent@0.83.0");
    expect(npmCalls).not.toContain("install -g");
  });

  it("replaces a Git checkout with origin/main before setup continues", () => {
    const { gitCalls, npmCalls, result } = runSetupFixture({ gitCheckout: true });

    expect(result.status).toBe(0);
    expect(gitCalls.trim().split("\n")).toEqual([
      "fetch --prune origin main",
      "status --porcelain",
      "rev-list --count origin/main..HEAD",
      "reset --hard origin/main",
      "clean -fd",
    ]);
    expect(npmCalls).toContain("run build");
    expect(result.stdout).toContain("本地程式碼已同步為 origin/main");
  });

  it("keeps the current checkout only when offline mode is explicit", () => {
    const { gitCalls, npmCalls, result } = runSetupFixture({ gitCheckout: true, offline: true });

    expect(result.status).toBe(0);
    expect(gitCalls).toBe("");
    expect(npmCalls).toContain("run build");
    expect(result.stdout).toContain("離線模式：跳過 origin/main 同步");
  });

  it("backs up a dirty checkout and stops instead of overwriting it non-interactively", () => {
    const { backupRoot, gitCalls, npmCalls, result } = runSetupFixture({ gitCheckout: true, dirty: true });

    expect(result.status).toBe(2);
    expect(gitCalls).not.toContain("reset --hard");
    expect(gitCalls).not.toContain("clean -fd");
    expect(npmCalls).toBe("");
    expect(result.stdout).toContain("已建立本地修改復原備份");
    expect(result.stdout).toContain("非互動模式不會自動覆蓋");
    const entries = readdirSync(backupRoot, { recursive: true }).map(String);
    expect(entries.some((entry) => entry.endsWith("working-tree.patch"))).toBe(true);
    expect(entries.some((entry) => entry.endsWith("status.txt"))).toBe(true);
  });

  it("syncs only after an explicit force flag and preserves local commits in a bundle", () => {
    const { backupRoot, gitCalls, npmCalls, result } = runSetupFixture({
      gitCheckout: true,
      localCommits: 2,
      forceSync: true,
    });

    expect(result.status).toBe(0);
    expect(gitCalls).toContain("bundle create");
    expect(gitCalls).toContain("reset --hard origin/main");
    expect(gitCalls).toContain("clean -fd");
    expect(npmCalls).toContain("run build");
    const entries = readdirSync(backupRoot, { recursive: true }).map(String);
    expect(entries.some((entry) => entry.endsWith("local-commits.bundle"))).toBe(true);
  });

  it("moves obsolete search files out of the source tree before building", () => {
    const { backupRoot, npmCalls, project, result } = runSetupFixture({ legacyFiles: true });

    expect(result.status).toBe(0);
    expect(npmCalls).toContain("run build");
    for (const file of LEGACY_FILES) {
      expect(existsSync(join(project, file))).toBe(false);
    }

    const backedUpFiles = readdirSync(backupRoot, { recursive: true })
      .map(String)
      .filter((entry) => !entry.endsWith("ui") && !entry.endsWith("sidebar"));
    for (const file of LEGACY_FILES) {
      const backedUpFile = backedUpFiles.find((entry) => entry.endsWith(file));
      expect(backedUpFile).toBeDefined();
      expect(readFileSync(join(backupRoot, backedUpFile!), "utf8")).toBe(`legacy:${file}\n`);
    }
    expect(result.stdout).toContain("已備份並移除舊版殘留檔案");
  });

  it("shows TypeScript errors and stops before the production build", () => {
    const { npmCalls, result } = runSetupFixture({ tscExit: 1 });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("TS setup failure");
    expect(npmCalls).not.toContain("run build");
  });
});
