import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStagedDeployment, validateStagedPlan } from "../../scripts/staged-deployment.mjs";

const roots: string[] = [];
const sha = "a".repeat(40);
const fixtureEnv = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
function identitySequence(...identities: Array<Record<string, unknown>>) {
  return vi.fn(async (_url: string, env: NodeJS.ProcessEnv) => {
    const identity = identities.shift();
    return env.PIWEB_ENVIRONMENT === "fixture" ? { ...identity, environment: "fixture", agentDir: env.PI_CODING_AGENT_DIR } : identity;
  });
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-stage-contract-")));
  roots.push(root);
  const stageDir = join(root, "stage");
  const liveDir = join(root, "live");
  await Promise.all([mkdir(stageDir), mkdir(liveDir)]);
  const expected = { version: "2026.09.07", sourceSha: sha };
  const plan = { stageDir, liveDir, expected, stageIdentityUrl: "http://127.0.0.1:30178/api/runtime/identity", liveIdentityUrl: "http://127.0.0.1:30179/api/runtime/identity",
    commands: Object.fromEntries(["build", "stageStart", "stageStop", "stop", "switch", "start", "rollback"].map(phase => [phase, ["/unused/operator-adapter", phase]])) };
  const previous = { pid: 100, startedAt: "2026-09-07T00:00:00Z", cwd: liveDir, build: { version: "2026.09.06", sourceSha: "b".repeat(40), dirty: false } };
  const candidate = { pid: 101, startedAt: "2026-09-07T01:00:00Z", cwd: stageDir, build: { ...expected, dirty: false } };
  return { plan, previous, candidate };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("staged deployment operator contract", () => {
  it("requires all cutover and rollback adapters before running anything", async () => {
    const { plan } = await fixture();
    expect(() => validateStagedPlan({ ...plan, commands: { ...plan.commands, rollback: undefined } })).toThrow(/rollback/);
    expect(() => validateStagedPlan({ ...plan, stageDir: join(plan.liveDir, "stage") })).toThrow(/separate/);
  });
  it("builds and health-checks isolated stage before stopping live, then verifies new running identity", async () => {
    const { plan, previous, candidate } = await fixture();
    const phases: string[] = [];
    const environments: Record<string, string>[] = [];
    const execute = vi.fn(async (phase: string, _argv: string[], _cwd: string, env: Record<string, string>) => { phases.push(phase); environments.push(env); });
    const readIdentity = identitySequence(candidate, previous, { ...candidate, cwd: plan.liveDir });
    const result = await runStagedDeployment(plan, fixtureEnv, { execute, readIdentity, assertCheckoutStopped: vi.fn(), attempts: 1 });
    expect(result.status).toBe("succeeded");
    expect(phases).toEqual(["build", "stageStart", "stageStop", "stop", "switch", "start"]);
    expect(environments[0]).toMatchObject({ PIWEB_ENVIRONMENT: "fixture", PIWEB_ACCESS_PASSWORD: "" });
    expect(environments[0].PI_CODING_AGENT_DIR).toContain("pi-staged-health-");
  });
  it("never touches live when stage health returns the wrong SHA", async () => {
    const { plan, candidate } = await fixture();
    const phases: string[] = [];
    await expect(runStagedDeployment(plan, fixtureEnv, {
      execute: async (phase: string) => { phases.push(phase); }, assertCheckoutStopped: vi.fn(), attempts: 1,
      readIdentity: identitySequence({ ...candidate, build: { ...candidate.build, sourceSha: "c".repeat(40) } }),
    })).rejects.toThrow(/not verified/);
    expect(phases).toEqual(["build", "stageStart", "stageStop"]);
  });
  it("allowlists candidate environment without leaking live credentials or runtime injection", async () => {
    const { plan, previous, candidate } = await fixture();
    const environments = new Map<string, NodeJS.ProcessEnv>();
    const liveEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test", PATH: "/usr/bin", HOME: "/fixture/home", LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "fixture-only-key", ANTHROPIC_API_KEY: "fixture-only-key",
      NODE_OPTIONS: "--require=/fixture/never-load.cjs", CUSTOM_SECRET: "fixture-only-secret",
      PIWEB_HOST: "0.0.0.0", PORT: "30141", PIWEB_ACCESS_PASSWORD: "fixture-only-password",
      PIWEB_SESSION_SECRET: "fixture-only-session", PIWEB_UPDATE_HEALTH_COOKIE: "fixture-only-cookie",
      PIWEB_UPDATE_COMMAND_JSON: '["/fixture/never-execute"]',
    };
    await runStagedDeployment(plan, liveEnv, {
      execute: async (phase: string, _argv: string[], _cwd: string, env: NodeJS.ProcessEnv) => { environments.set(phase, env); },
      readIdentity: identitySequence(candidate, previous, { ...candidate, cwd: plan.liveDir }),
      assertCheckoutStopped: vi.fn(), attempts: 1,
    });
    for (const phase of ["build", "stageStart", "stageStop"]) {
      const env = environments.get(phase)!;
      expect(env).toMatchObject({ PATH: liveEnv.PATH, HOME: liveEnv.HOME, LANG: liveEnv.LANG, PIWEB_ENVIRONMENT: "fixture", PIWEB_HOST: "127.0.0.1", PORT: "30178" });
      for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "CUSTOM_SECRET", "PIWEB_UPDATE_COMMAND_JSON"]) expect(env).not.toHaveProperty(key);
      for (const key of ["PIWEB_ACCESS_PASSWORD", "PIWEB_SESSION_SECRET", "PIWEB_UPDATE_HEALTH_COOKIE"]) expect(env[key] ?? "").toBe("");
    }
    expect(environments.get("start")).toMatchObject(liveEnv);
  });
  it("rolls back and verifies the previous build when cutover fails", async () => {
    const { plan, previous, candidate } = await fixture();
    const phases: string[] = [];
    const readIdentity = identitySequence(candidate, previous, { ...previous, pid: 102, startedAt: "2026-09-07T02:00:00Z" });
    await expect(runStagedDeployment(plan, fixtureEnv, {
      execute: async (phase: string) => { phases.push(phase); if (phase === "switch") throw new Error("fixture failure"); },
      readIdentity, assertCheckoutStopped: vi.fn(), attempts: 1,
    })).rejects.toMatchObject({ rollbackVerified: true });
    expect(phases).toEqual(["build", "stageStart", "stageStop", "stop", "switch", "stop", "rollback", "start"]);
  });
  it("preserves the private fixture directory and never cuts over when stage stop fails", async () => {
    const { plan, candidate } = await fixture();
    let privateDirectory = "";
    const phases: string[] = [];
    await expect(runStagedDeployment(plan, fixtureEnv, {
      execute: async (phase: string, _argv: string[], _cwd: string, env: Record<string, string>) => {
        phases.push(phase); privateDirectory = env.PI_CODING_AGENT_DIR;
        if (phase === "stageStop") throw new Error("cannot stop fixture adapter");
      },
      readIdentity: identitySequence(candidate), assertCheckoutStopped: vi.fn(), attempts: 1,
    })).rejects.toThrow(/stage.*stop/i);
    roots.push(privateDirectory);
    await expect(access(privateDirectory)).resolves.toBeUndefined();
    expect(phases).toEqual(["build", "stageStart", "stageStop"]);
  });
  it("refuses a candidate that ignored the isolated agent directory", async () => {
    const { plan, candidate } = await fixture();
    const phases: string[] = [];
    await expect(runStagedDeployment(plan, fixtureEnv, {
      execute: async (phase: string) => { phases.push(phase); }, assertCheckoutStopped: vi.fn(), attempts: 1,
      readIdentity: async () => ({ ...candidate, environment: "fixture", agentDir: "/not-the-private-fixture" }),
    })).rejects.toThrow(/not verified/);
    expect(phases).toEqual(["build", "stageStart", "stageStop"]);
  });
  it("never switches source when the stopped-service guard still detects a live process", async () => {
    const { plan, previous, candidate } = await fixture();
    const phases: string[] = [];
    await expect(runStagedDeployment(plan, fixtureEnv, {
      execute: async (phase: string) => { phases.push(phase); }, attempts: 1,
      assertCheckoutStopped: async (cwd: string) => { if (cwd === plan.liveDir) throw new Error("still running"); },
      readIdentity: identitySequence(candidate, previous),
    })).rejects.toThrow(/operator recovery/);
    expect(phases).toEqual(["build", "stageStart", "stageStop", "stop", "stop"]);
  });
});
