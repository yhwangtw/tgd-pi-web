import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runInstallationSmoke, validateArchiveEntries } from "../../scripts/ci-install-smoke.mjs";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
describe("isolated installation smoke harness", () => {
  it.each(["../escape", "/absolute", "nested/../../escape", ".env", "nested/.env.local", ".git/config", "models.json", "auth.json"])("refuses unsafe source entry %s", entry => {
    expect(() => validateArchiveEntries([entry])).toThrow();
  });
  it("accepts ordinary committed source and environment examples", () => {
    expect(() => validateArchiveEntries(["setup.sh", "package.json", "lib/config.ts", ".env.example", "docs/example.env"])).not.toThrow();
  });
  it("executes source archive and offline checkout setup using only committed source", async () => {
    const root = await mkdtemp(join(tmpdir(), "piweb-install-smoke-test-")); directories.push(root);
    const repository = join(root, "source"); await mkdir(repository);
    const evidence = join(root, "evidence.txt");
    const cache = join(root, "cache"); await mkdir(cache);
    await writeFile(join(cache, "keep-cache.txt"), "private cache stays intact");
    await writeFile(join(repository, "package.json"), '{"name":"smoke-fixture","private":true}\n');
    await writeFile(join(repository, "setup.sh"), `#!/bin/sh
set -eu
test "$TGD_SETUP_OFFLINE" = 1
test "$npm_config_offline" = true
test "$npm_config_audit" = false
test -f "$npm_config_userconfig"
test ! -e private-untracked.txt
test "$PI_CODING_AGENT_DIR" != "$PWD"
if test -d .git; then
  mode=offline-checkout
  test ! -e ../source-archive
else
  mode=source-archive
fi
printf '%s\\n' "$mode" >> ${JSON.stringify(evidence)}
mkdir -p .next
printf 'fixture-build' > .next/BUILD_ID
`);
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["-C", repository, "add", "package.json", "setup.sh"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    await writeFile(join(repository, "private-untracked.txt"), "must not copy");
    const before = execFileSync("git", ["-C", repository, "status", "--porcelain"], { encoding: "utf8" });
    const result = await runInstallationSmoke({ repository, cache, log: () => {} });
    expect(result.modes).toEqual(["source-archive", "offline-checkout"]);
    expect(await readFile(evidence, "utf8")).toBe("source-archive\noffline-checkout\n");
    expect(execFileSync("git", ["-C", repository, "status", "--porcelain"], { encoding: "utf8" })).toBe(before);
    expect(await readFile(join(repository, "private-untracked.txt"), "utf8")).toBe("must not copy");
    expect(await readFile(join(cache, "keep-cache.txt"), "utf8")).toBe("private cache stays intact");
    await expect(readFile(join(repository, ".next", "BUILD_ID"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
