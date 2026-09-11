import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Archives contain reviewed Git blobs only, never private runtime/config data. */
export function validateArchiveEntries(entries) {
  for (const entry of entries) {
    const parts = entry.split("/");
    if (!entry || isAbsolute(entry) || entry.includes("\\") || parts.some(part => !part || part === ".." || part === ".git" || part === "node_modules" || part === ".next")
      || parts.some(part => /^\.env(?:\.|$)/.test(part) && !/^\.env\.(?:example|sample|template)$/.test(part))
      || parts.some(part => ["auth.json", "models.json", "models-config-backups", "file-mutation-locks"].includes(part))) {
      throw new Error("Source archive contains a private or unsupported entry; smoke stopped before extraction");
    }
  }
}

/** Real setup runs in throwaway source directories; the calling checkout is read-only.
 * npm ci in the CI job prewarms its platform-specific cache. npm install, tsc and
 * next build below remain real commands, with npm networking explicitly disabled.
 */
export async function runInstallationSmoke({ repository = projectRoot, cache = process.env.npm_config_cache ?? join(homedir(), ".npm"), log = console.log } = {}) {
  const source = resolve(repository);
  const taskDirectory = await mkdtemp(join(tmpdir(), "piweb-install-smoke-"));
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    LANG: "en_US.UTF-8", CI: "true", NEXT_TELEMETRY_DISABLED: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    TGD_SETUP_OFFLINE: "1", TGD_SETUP_SOURCE_SYNCED: "0", TGD_SETUP_FORCE_SYNC: "0",
    TGD_SETUP_BACKUP_DIR: join(taskDirectory, "source-backups"),
    PI_CODING_AGENT_DIR: join(taskDirectory, "agent-data"),
    npm_config_cache: resolve(cache), npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false",
    npm_config_userconfig: join(taskDirectory, "empty-user.npmrc"),
    npm_config_globalconfig: join(taskDirectory, "empty-global.npmrc"),
  };
  const command = (executable, args, cwd = source, capture = true) => execFileSync(executable, args, {
    cwd, env: environment, encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });
  try {
    await Promise.all([
      writeFile(environment.npm_config_userconfig, "", { mode: 0o600 }),
      writeFile(environment.npm_config_globalconfig, "", { mode: 0o600 }),
      mkdir(environment.PI_CODING_AGENT_DIR, { mode: 0o700 }),
    ]);
    const sha = command("git", ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Smoke requires a committed Git source");
    const tree = command("git", ["ls-tree", "-r", "-z", "--full-tree", sha]).split("\0").filter(Boolean);
    const entries = tree.map(entry => {
      const tab = entry.indexOf("\t");
      const metadata = entry.slice(0, tab);
      if (tab < 0 || !/^100(?:644|755) blob [a-f0-9]{40}$/.test(metadata)) throw new Error("Smoke archives require regular committed files, not symlinks or submodules");
      return entry.slice(tab + 1);
    });
    validateArchiveEntries(entries);
    for (const required of ["setup.sh", "package.json"]) if (!entries.includes(required)) throw new Error("Smoke archive is missing installation source");
    const archive = join(taskDirectory, "source.tar");
    command("git", ["archive", "--format=tar", `--output=${archive}`, sha]);
    log(`Installation smoke: Node ${process.versions.node} on ${process.platform}/${process.arch}; committed source ${sha}. Uncommitted/untracked files are not copied.`);
    const modes = ["source-archive", "offline-checkout"];
    for (const mode of modes) {
      const candidate = join(taskDirectory, mode);
      await mkdir(candidate, { mode: 0o700 });
      command("tar", ["-xf", archive, "-C", candidate]);
      if (mode === "offline-checkout") {
        command("git", ["init", "--quiet"], candidate);
        // A fetch would fail, proving offline setup does not require a remote.
        command("git", ["remote", "add", "origin", join(taskDirectory, "intentionally-absent-remote")], candidate);
      }
      log(`Running real ${mode} setup with offline npm and isolated agent data`);
      command("bash", ["setup.sh"], candidate, false);
      const buildId = (await readFile(join(candidate, ".next", "BUILD_ID"), "utf8")).trim();
      if (!buildId) throw new Error(`${mode} did not produce a production build identity`);
      log(`Verified ${mode}: setup exited successfully and produced .next/BUILD_ID`);
      // Keep peak usage to one install/build. This path was created by this
      // iteration; the source repository and shared npm cache are not removed.
      await rm(candidate, { recursive: true, force: true });
    }
    return { sha, node: process.versions.node, platform: process.platform, modes };
  } finally {
    // Only the directory created by this call is removed; never the source/cache.
    await rm(taskDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInstallationSmoke().catch(() => {
    console.error("Installation smoke failed. Review the preceding isolated setup output; the source checkout was not modified.");
    process.exitCode = 1;
  });
}
