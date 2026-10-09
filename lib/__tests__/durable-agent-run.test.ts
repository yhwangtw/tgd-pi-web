import { afterEach, describe, expect, it, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  fauxProvider, fauxAssistantMessage, fauxToolCall, createModels, Type,
} from "@earendil-works/pi-ai-durable";
import { createRegistry, defineExtension, defineTool, type HarnessOptions } from "@earendil-works/pi-durable";
import { openDurableAgentRun, type DurableRunHandle } from "../durable-agent-run";
import type { AgentRun } from "../agent-run-types";

const directories: string[] = [];
const handles: DurableRunHandle[] = [];
const children: ChildProcess[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-durable-run-test-"));
  directories.push(directory);
  const run: AgentRun = {
    id: randomUUID(), engine: "durable", name: "Durable test", cwd: directory,
    prompt: "Do the task", provider: "durable-test", modelId: "test",
    toolNames: [], createdAt: new Date().toISOString(), status: "running", trigger: "manual",
    limits: { timeoutMs: 0 },
  };
  const faux = fauxProvider({ provider: run.provider, models: [{ id: "test" }], tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  return { directory, run, faux, models: models as unknown as HarnessOptions["models"], registry };
}

async function open(input: ReturnType<typeof fixture>, extra: Parameters<typeof openDurableAgentRun>[1] = {}) {
  const handle = await openDurableAgentRun(input.run, { ...input, ...extra });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("official Pi Durable background runs", () => {
  it("persists a completed result and deduplicates submission after reopen", async () => {
    const input = fixture();
    input.faux.setResponses([fauxAssistantMessage("Saved answer")]);
    const first = await open(input);
    expect((await first.run()).messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "Saved answer" }] })]));
    await first.close();
    const second = await open(input);
    const result = await second.run();
    expect(result.error).toBeUndefined();
    expect(input.faux.state.callCount).toBe(1);
    expect(result.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(statSync(join(input.directory, "agent.sqlite")).mode & 0o777).toBe(0o600);
    expect(statSync(join(input.directory, "transcript.json")).mode & 0o777).toBe(0o600);
  });

  it("executes the existing file tools and returns their result to the model", async () => {
    const input = fixture();
    input.run.toolNames = ["write", "read"];
    input.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "Durable file result" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "result.txt" }), { stopReason: "toolUse" }),
      transcript => {
        expect(transcript.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "toolResult", toolName: "read", content: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: expect.stringContaining("Durable file result") }),
          ]) }),
        ]));
        return fauxAssistantMessage("File verified");
      },
    ]);
    const handle = await open(input, { registry: undefined });
    const result = await handle.run();
    expect(result.error).toBeUndefined();
    expect(readFileSync(join(input.directory, "result.txt"), "utf8")).toBe("Durable file result");
    expect(input.faux.state.callCount).toBe(3);
  });

  it("enforces a turn budget before another model request, including after reopening", async () => {
    const input = fixture();
    input.run.limits = { maxTurns: 1, timeoutMs: 0 };
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Inspected" }] }));
    input.registry.install(defineExtension({ name: "test-tools", tools: [defineTool({ name: "inspect", description: "Inspect", parameters: Type.Object({}), replay: "safe", execute })] }));
    input.faux.setResponses([fauxAssistantMessage(fauxToolCall("inspect", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Must not happen")]);
    const first = await open(input);
    const result = await first.run();
    expect(result.error).toMatch(/1-turn limit/);
    expect(execute).toHaveBeenCalledOnce();
    expect(input.faux.state.callCount).toBe(1);
    await first.close();
    const reopened = await open(input);
    expect((await reopened.run()).error).toBeTruthy();
    expect(input.faux.state.callCount).toBe(1);
  });

  it("rejects resumed execution after trust is revoked", async () => {
    const input = fixture();
    input.faux.setResponses([fauxAssistantMessage("Never called")]);
    const handle = await open(input, { trusted: async () => false });
    expect((await handle.run()).error).toMatch(/no longer trusted/);
    expect(input.faux.state.callCount).toBe(0);
  });

  it("cancels pending work durably rather than resuming it after reopen", async () => {
    const input = fixture();
    input.faux.setResponses([(_transcript, options) => new Promise((resolve) => {
      options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
    })]);
    const first = await open(input);
    const running = first.run();
    await vi.waitFor(() => expect(input.faux.state.callCount).toBe(1));
    await first.abort();
    expect((await running).error).toBeTruthy();
    await first.close();
    input.faux.setResponses([fauxAssistantMessage("Must not resume")]);
    const reopened = await open(input);
    expect((await reopened.run()).error).toBeTruthy();
    expect(input.faux.state.callCount).toBe(1);
  });

  it("recovers after SIGKILL without repeating a side effect interrupted mid-tool", async () => {
    const input = fixture();
    const runPath = join(input.directory, "run.json");
    writeFileSync(runPath, JSON.stringify(input.run));
    const child = fork(resolve("lib/__tests__/fixtures/durable-crash.mjs"), [runPath], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, PI_CODING_AGENT_DIR: input.directory },
      execArgv: ["--experimental-strip-types", "--no-warnings"],
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += chunk; });
    await new Promise<void>((resolveReady, reject) => {
      child.on("message", message => { if (message === "effect-written") resolveReady(); });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Crash fixture exited ${code}: ${stderr}`)));
    });
    const signal = await new Promise<NodeJS.Signals | null>(resolveExit => { child.once("exit", (_code, signal) => resolveExit(signal)); child.kill("SIGKILL"); });
    expect(signal).toBe("SIGKILL");
    expect(readFileSync(join(input.directory, "effect.txt"), "utf8")).toBe("once");
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Duplicated" }] }));
    input.registry.install(defineExtension({ name: "test-tools", tools: [defineTool({ name: "side_effect", description: "Side effect", parameters: Type.Object({}), execute })] }));
    input.faux.setResponses([(transcript) => {
      expect(transcript.messages.some(message => message.role === "toolResult" && message.isError)).toBe(true);
      return fauxAssistantMessage("Recovered without replaying the effect");
    }]);
    const resumed = await open(input);
    const result = await resumed.run();
    expect(result.error).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(result.messages.filter(message => message.role === "user")).toHaveLength(1);
  }, 30_000);
});
