import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAuthWebBridge,
  resetOAuthWebInputsForTests,
  submitOAuthWebInput,
  type OAuthWebEvent,
} from "../oauth-web-bridge";

afterEach(resetOAuthWebInputsForTests);

describe("OAuthWebBridge", () => {
  it("round-trips provider selections", async () => {
    const events: OAuthWebEvent[] = [];
    const bridge = new OAuthWebBridge("openai-codex", (event) => events.push(event));
    const pending = bridge.interaction.prompt({
      type: "select",
      message: "Choose a login method",
      options: [{ id: "device_code", label: "Device code" }],
    });

    expect(events[0]).toMatchObject({ type: "select_request", message: "Choose a login method" });
    const token = (events[0] as Extract<OAuthWebEvent, { type: "select_request" }>).token;
    expect(submitOAuthWebInput("openai-codex", token, "device_code")).toBe("accepted");
    await expect(pending).resolves.toBe("device_code");
  });

  it("reuses an auth-url token for the following manual-code prompt", async () => {
    const events: OAuthWebEvent[] = [];
    const bridge = new OAuthWebBridge("openai-codex", (event) => events.push(event));
    bridge.interaction.notify({ type: "auth_url", url: "https://auth.example", instructions: "Sign in" });
    const authEvent = events[0] as Extract<OAuthWebEvent, { type: "auth" }>;
    const pending = bridge.interaction.prompt({
      type: "manual_code",
      message: "Paste the redirect URL",
      placeholder: "http://localhost/callback",
    });

    expect(events).toHaveLength(1);
    expect(authEvent).toMatchObject({ type: "auth", url: "https://auth.example", instructions: "Sign in" });
    expect(submitOAuthWebInput("openai-codex", authEvent.token, "callback-code")).toBe("accepted");
    await expect(pending).resolves.toBe("callback-code");
  });

  it("maps device-code, info, and progress notifications", () => {
    const send = vi.fn();
    const bridge = new OAuthWebBridge("github-copilot", send);
    bridge.interaction.notify({
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    bridge.interaction.notify({
      type: "info",
      message: "Read the guide",
      links: [{ url: "https://example.com/guide", label: "Guide" }],
    });
    bridge.interaction.notify({ type: "progress", message: "Waiting" });

    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "device_code", userCode: "ABCD-EFGH" }));
    expect(send).toHaveBeenNthCalledWith(2, { type: "progress", message: "Read the guide https://example.com/guide" });
    expect(send).toHaveBeenNthCalledWith(3, { type: "progress", message: "Waiting" });
  });

  it("rejects wrong-provider and unknown tokens", async () => {
    const events: OAuthWebEvent[] = [];
    const bridge = new OAuthWebBridge("openai-codex", (event) => events.push(event));
    const pending = bridge.interaction.prompt({ type: "text", message: "Value" });
    const token = (events[0] as Extract<OAuthWebEvent, { type: "prompt_request" }>).token;

    expect(submitOAuthWebInput("github-copilot", token, "value")).toBe("provider_mismatch");
    expect(submitOAuthWebInput("openai-codex", "missing", "value")).toBe("not_found");
    bridge.cleanup();
    await expect(pending).rejects.toThrow("Login cancelled");
  });

  it("cancels pending input when the login or prompt aborts", async () => {
    const loginAbort = new AbortController();
    const loginEvents: OAuthWebEvent[] = [];
    const loginBridge = new OAuthWebBridge("openai-codex", (event) => loginEvents.push(event), loginAbort.signal);
    const loginPending = loginBridge.interaction.prompt({ type: "text", message: "Value" });
    loginAbort.abort();
    await expect(loginPending).rejects.toThrow("Login cancelled");

    const promptAbort = new AbortController();
    const promptBridge = new OAuthWebBridge("anthropic", () => {});
    const promptPending = promptBridge.interaction.prompt({
      type: "manual_code",
      message: "Code",
      signal: promptAbort.signal,
    });
    promptAbort.abort();
    await expect(promptPending).rejects.toThrow("Login prompt cancelled");
  });
});
