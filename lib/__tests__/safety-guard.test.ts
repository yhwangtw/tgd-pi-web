import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { SAFETY_GRANT_TTL_MS, classifyToolCall, createSafetyGuardExtension } from "../safety-guard";
import { WebExtensionUIBridge, toEnumerableExtensionUIContext, type WebExtensionUIEvent } from "../web-extension-ui";

function tool(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "call-1", toolName, input } as ToolCallEvent;
}

describe("classifyToolCall", () => {
  it.each([
    ["rm -rf ./build", "destructive-command"],
    ["rm -r ./build", "destructive-command"],
    ["git reset --hard HEAD~1", "destructive-command"],
    ["git restore components/Button.tsx", "destructive-command"],
    ["git checkout -f release", "destructive-command"],
    ["git switch --force release", "destructive-command"],
    ["npm install left-pad", "dependency-install"],
    ["git config --global credential.helper store", "protected-path"],
    ["gh auth refresh", "secret-access"],
    ["git push origin main", "external-mutation"],
    ["curl -X POST https://api.example.test/releases", "external-mutation"],
    ["gh api --method DELETE repos/acme/demo/releases/1", "external-mutation"],
    ["cat ~/.ssh/id_ed25519", "secret-access"],
    ["printf secret > .env.local", "protected-path"],
    ["rm .github/workflows/release.yml", "protected-path"],
    ["sed -i 's/old/new/' wrangler.toml", "protected-path"],
    ["cat ../other/secrets.txt", "outside-workspace"],
    ["env -i cat /etc/passwd", "outside-workspace"],
    ["git -C ../other-repo status", "outside-workspace"],
    ["printf data > ../outside.txt", "outside-workspace"],
  ])("classifies risky command %s", (command, code) => {
    expect(classifyToolCall(tool("bash", { command }), "/tmp/project")?.code).toBe(code);
  });

  it("allows ordinary workspace commands and edits", () => {
    expect(classifyToolCall(tool("bash", { command: "npm test" }), "/tmp/project")).toBeNull();
    expect(classifyToolCall(tool("bash", { command: "cat .env.example" }), "/tmp/project")).toBeNull();
    expect(classifyToolCall(tool("bash", { command: "git config --get remote.origin.url" }), "/tmp/project")).toBeNull();
    expect(classifyToolCall(tool("edit", { path: "components/Button.tsx", edits: [] }), "/tmp/project")).toBeNull();
  });

  it("protects sensitive and outside-workspace paths", () => {
    expect(classifyToolCall(tool("write", { path: ".env", content: "x" }), "/tmp/project")?.code).toBe("protected-path");
    expect(classifyToolCall(tool("read", { path: ".github/workflows/ci.yml" }), "/tmp/project")?.code).toBe("secret-access");
    expect(classifyToolCall(tool("edit", { path: "../other/file.ts", edits: [] }), "/tmp/project")?.code).toBe("outside-workspace");
  });
});

describe("Safety Guard extension", () => {
  it("drives the real Web extension dialog bridge for approval", async () => {
    let handler: ((event: ToolCallEvent, ctx: Record<string, unknown>) => Promise<unknown>) | undefined;
    const events: WebExtensionUIEvent[] = [];
    const bridge = new WebExtensionUIBridge({
      theme: {} as ExtensionUIContext["theme"],
      emit: (event) => events.push(event),
    });
    const extension = createSafetyGuardExtension({ recordActivity: vi.fn() });
    if (typeof extension === "function") throw new Error("Expected named extension");
    extension.factory({ on: vi.fn((_name, next) => { handler = next as typeof handler; }) } as never);

    const decision = handler?.(tool("bash", { command: "git push origin main" }), {
      cwd: "/tmp/project",
      hasUI: true,
      ui: toEnumerableExtensionUIContext(bridge),
    });
    const confirmRequest = events.at(-1)!;
    expect(confirmRequest).toMatchObject({ method: "confirm", title: expect.stringContaining("Change an external") });
    bridge.respond({ type: "extension_ui_response", id: confirmRequest.id, confirmed: true });
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ method: "select", title: "Approval duration" }));
    const durationRequest = events.at(-1)!;
    bridge.respond({ type: "extension_ui_response", id: durationRequest.id, value: "Allow once" });

    await expect(decision).resolves.toBeUndefined();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "extension_ui_closed", id: confirmRequest.id, reason: "answered" }),
      expect.objectContaining({ type: "extension_ui_closed", id: durationRequest.id, reason: "answered" }),
    ]));
  });

  it("blocks risky work without an interactive UI", async () => {
    let handler: ((event: ToolCallEvent, ctx: Record<string, unknown>) => Promise<unknown>) | undefined;
    const recordActivity = vi.fn();
    const extension = createSafetyGuardExtension({ recordActivity });
    if (typeof extension === "function") throw new Error("Expected named extension");
    extension.factory({ on: vi.fn((_name, next) => { handler = next as typeof handler; }) } as never);
    const result = await handler?.(tool("bash", { command: "sudo reboot" }), { cwd: "/tmp/project", hasUI: false });
    expect(result).toMatchObject({ block: true });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied", cwd: "/tmp/project" }));
  });

  it("asks before risky work and respects the answer", async () => {
    let handler: ((event: ToolCallEvent, ctx: Record<string, unknown>) => Promise<unknown>) | undefined;
    const recordActivity = vi.fn();
    const extension = createSafetyGuardExtension({ recordActivity });
    if (typeof extension === "function") throw new Error("Expected named extension");
    extension.factory({ on: vi.fn((_name, next) => { handler = next as typeof handler; }) } as never);
    const confirm = vi.fn(async () => false);
    const select = vi.fn();
    const result = await handler?.(tool("bash", { command: "git push origin main" }), {
      cwd: "/tmp/project",
      hasUI: true,
      ui: { confirm, select },
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Change an external"), expect.stringContaining("git push"));
    expect(select).not.toHaveBeenCalled();
    expect(result).toMatchObject({ block: true });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied", target: "bash" }));
  });

  it("can reuse one exact approval for five minutes and expires it", async () => {
    let handler: ((event: ToolCallEvent, ctx: Record<string, unknown>) => Promise<unknown>) | undefined;
    let currentTime = 10_000;
    const recordActivity = vi.fn();
    const extension = createSafetyGuardExtension({ recordActivity, now: () => currentTime });
    if (typeof extension === "function") throw new Error("Expected named extension");
    extension.factory({ on: vi.fn((_name, next) => { handler = next as typeof handler; }) } as never);
    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "Allow this exact action for 5 minutes");
    const event = tool("bash", { command: "git push origin main" });

    expect(await handler?.(event, {
      cwd: "/tmp/project",
      hasUI: true,
      ui: { confirm, select },
    })).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith("Approval duration", ["Allow once", "Allow this exact action for 5 minutes"]);

    expect(await handler?.(event, { cwd: "/tmp/project", hasUI: false })).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(recordActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "reviewed",
      details: expect.objectContaining({ authorizationScope: "exact-operation", reused: true }),
    }));

    currentTime += SAFETY_GRANT_TTL_MS + 1;
    expect(await handler?.(event, { cwd: "/tmp/project", hasUI: false })).toMatchObject({ block: true });
  });

  it("scopes remembered approval to the exact operation and workspace", async () => {
    let handler: ((event: ToolCallEvent, ctx: Record<string, unknown>) => Promise<unknown>) | undefined;
    const extension = createSafetyGuardExtension({ recordActivity: vi.fn() });
    if (typeof extension === "function") throw new Error("Expected named extension");
    extension.factory({ on: vi.fn((_name, next) => { handler = next as typeof handler; }) } as never);
    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "Allow this exact action for 5 minutes");
    await handler?.(tool("bash", { command: "git push origin main" }), {
      cwd: "/tmp/project",
      hasUI: true,
      ui: { confirm, select },
    });

    expect(await handler?.(tool("bash", { command: "git push origin release" }), {
      cwd: "/tmp/project",
      hasUI: false,
    })).toMatchObject({ block: true });
    expect(await handler?.(tool("bash", { command: "git push origin main" }), {
      cwd: "/tmp/other-project",
      hasUI: false,
    })).toMatchObject({ block: true });
  });
});
