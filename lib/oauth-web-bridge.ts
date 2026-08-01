import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export type OAuthWebEvent =
  | { type: "auth"; url: string; instructions: string | null; token: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { type: "prompt_request"; message: string; placeholder: string | null; token: string }
  | { type: "select_request"; message: string; options: readonly { id: string; label: string; description?: string }[]; token: string }
  | { type: "progress"; message: string };

interface PendingOAuthInput {
  provider: string;
  resolve(value: string): void;
  reject(error: Error): void;
}

interface InputRequest {
  token: string;
  promise: Promise<string>;
}

declare global {
  var __piLoginCallbacks: Map<string, PendingOAuthInput> | undefined;
}

function registry(): Map<string, PendingOAuthInput> {
  if (!globalThis.__piLoginCallbacks) globalThis.__piLoginCallbacks = new Map();
  return globalThis.__piLoginCallbacks;
}

export function submitOAuthWebInput(
  provider: string,
  token: string,
  value: string,
): "accepted" | "not_found" | "provider_mismatch" {
  const pending = registry().get(token);
  if (!pending) return "not_found";
  if (pending.provider !== provider) return "provider_mismatch";
  pending.resolve(value);
  return "accepted";
}

export function resetOAuthWebInputsForTests(): void {
  for (const pending of registry().values()) pending.reject(new Error("Test reset"));
  registry().clear();
}

export class OAuthWebBridge {
  private readonly activeTokens = new Set<string>();
  private manualRequest: InputRequest | undefined;

  readonly interaction: AuthInteraction;

  constructor(
    private readonly provider: string,
    private readonly send: (event: OAuthWebEvent) => void,
    signal?: AbortSignal,
  ) {
    this.interaction = {
      signal,
      prompt: (prompt) => this.prompt(prompt),
      notify: (event) => this.notify(event),
    };
    signal?.addEventListener("abort", () => this.cleanup(), { once: true });
  }

  private createInputRequest(): InputRequest {
    const token = `${this.provider}-${crypto.randomUUID()}`;
    this.activeTokens.add(token);
    const promise = new Promise<string>((resolve, reject) => {
      registry().set(token, {
        provider: this.provider,
        resolve: (value) => {
          this.activeTokens.delete(token);
          registry().delete(token);
          resolve(value);
        },
        reject: (error) => {
          this.activeTokens.delete(token);
          registry().delete(token);
          reject(error);
        },
      });
    });
    return { token, promise };
  }

  private getManualRequest(): InputRequest {
    if (!this.manualRequest) {
      this.manualRequest = this.createInputRequest();
      this.manualRequest.promise
        .finally(() => { this.manualRequest = undefined; })
        .catch(() => {});
    }
    return this.manualRequest;
  }

  private waitForPrompt(request: InputRequest, signal?: AbortSignal): Promise<string> {
    if (!signal) return request.promise;
    if (signal.aborted) {
      registry().get(request.token)?.reject(new Error("Login prompt cancelled"));
      return request.promise;
    }
    const abort = () => registry().get(request.token)?.reject(new Error("Login prompt cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    return request.promise.finally(() => signal.removeEventListener("abort", abort));
  }

  private async prompt(prompt: AuthPrompt): Promise<string> {
    if (prompt.type === "select") {
      const request = this.createInputRequest();
      this.send({
        type: "select_request",
        message: prompt.message,
        options: prompt.options,
        token: request.token,
      });
      return this.waitForPrompt(request, prompt.signal);
    }

    const hadPendingManualRequest = prompt.type === "manual_code" && this.manualRequest !== undefined;
    const request = prompt.type === "manual_code" ? this.getManualRequest() : this.createInputRequest();
    if (!hadPendingManualRequest) {
      this.send({
        type: "prompt_request",
        message: prompt.message,
        placeholder: prompt.placeholder ?? null,
        token: request.token,
      });
    }
    return this.waitForPrompt(request, prompt.signal);
  }

  private notify(event: AuthEvent): void {
    if (event.type === "auth_url") {
      const request = this.getManualRequest();
      this.send({
        type: "auth",
        url: event.url,
        instructions: event.instructions ?? null,
        token: request.token,
      });
      return;
    }
    if (event.type === "device_code") {
      this.send({
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        intervalSeconds: event.intervalSeconds ?? null,
        expiresInSeconds: event.expiresInSeconds ?? null,
      });
      return;
    }
    if (event.type === "info") {
      const links = event.links?.map((link) => link.url).join(" ");
      this.send({ type: "progress", message: [event.message, links].filter(Boolean).join(" ") });
      return;
    }
    this.send({ type: "progress", message: event.message });
  }

  cleanup(error = new Error("Login cancelled")): void {
    for (const token of [...this.activeTokens]) registry().get(token)?.reject(error);
    this.activeTokens.clear();
  }
}
