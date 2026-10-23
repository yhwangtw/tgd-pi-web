import { randomUUID } from "node:crypto";

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1 as const;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_RPC_METHODS = ["ping", "status", "manage", "spawn", "steer", "interrupt", "stop", "resume", "cost"] as const;
export type SubagentRpcMethod = (typeof SUBAGENT_RPC_METHODS)[number];
export type Unsubscribe = (() => void) | void;
/** Structural subset of pi.events; no dependency on the Pi SDK. */
export interface EventBus { on(event: string, handler: (data: unknown) => void): Unsubscribe; emit(event: string, data: unknown): void }
export interface RpcReady { version: 1; methods?: readonly string[]; capabilities?: unknown; [key: string]: unknown }
export interface ClientOptions { timeoutMs?: number; requireReady?: boolean }
export interface RequestOptions extends ClientOptions { requestId?: string; readyTimeoutMs?: number; signal?: AbortSignal; source?: { extension?: string; [key: string]: unknown } }
export class RpcClientError extends Error {
	constructor(public readonly code: string, message: string) { super(message); this.name = "RpcClientError"; }
}
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
function boundedTimeout(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function subagentRpcReplyEvent(requestId: string): string { return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`; }
type Cancel = (error: RpcClientError) => void;

export class SubagentRpcClient {
	private readyState: RpcReady | undefined;
	private disposed = false;
	private readonly pending = new Set<Cancel>();
	private readonly offReady: Unsubscribe;
	private readonly timeoutMs: number;
	private readonly requireReady: boolean;

	constructor(private readonly events: EventBus, options: ClientOptions = {}) {
		this.timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
		this.requireReady = options.requireReady ?? false;
		this.offReady = events.on(SUBAGENT_RPC_READY_EVENT, (data) => {
			if (isRecord(data) && data.version === SUBAGENT_RPC_PROTOCOL_VERSION) this.readyState = data as RpcReady;
		});
	}

	isReady(): boolean { return this.readyState !== undefined; }

	waitForReady(timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<RpcReady> {
		if (this.disposed) return Promise.reject(new RpcClientError("disposed", "RPC client is disposed."));
		if (this.readyState) return Promise.resolve(this.readyState);
		const bounded = boundedTimeout(timeoutMs, this.timeoutMs);
		return new Promise<RpcReady>((resolve, reject) => {
			let off: Unsubscribe = undefined, timer: ReturnType<typeof setTimeout> | undefined = undefined, settled = false;
			const cleanup = () => {
				if (typeof off === "function") off();
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(cancel);
			};
			const cancel = (error: RpcClientError) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const onAbort = () => cancel(new RpcClientError("aborted", "RPC readiness wait was aborted."));
			const onReady = (data: unknown) => {
				if (!isRecord(data) || data.version !== SUBAGENT_RPC_PROTOCOL_VERSION) return;
				this.readyState = data as RpcReady;
				if (settled) return;
				settled = true;
				cleanup();
				resolve(this.readyState);
			};
			if (signal?.aborted) return onAbort();
			off = this.events.on(SUBAGENT_RPC_READY_EVENT, onReady);
			this.pending.add(cancel);
			signal?.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => cancel(new RpcClientError("timeout", `RPC readiness timed out after ${bounded}ms.`)), bounded);
		});
	}

	async request<T = unknown>(method: SubagentRpcMethod, params?: unknown, options: RequestOptions = {}): Promise<T> {
		if (this.disposed) throw new RpcClientError("disposed", "RPC client is disposed.");
		if (options.requireReady ?? this.requireReady) {
			await this.waitForReady(options.readyTimeoutMs ?? options.timeoutMs ?? this.timeoutMs, options.signal);
		}
		if (this.disposed) throw new RpcClientError("disposed", "RPC client is disposed.");
		const requestId = options.requestId ?? randomUUID();
		const timeout = boundedTimeout(options.timeoutMs, this.timeoutMs);
		return new Promise<T>((resolve, reject) => {
			let offReply: Unsubscribe = undefined, timer: ReturnType<typeof setTimeout> | undefined = undefined, settled = false;
			const cleanup = () => {
				if (typeof offReply === "function") offReply();
				if (timer !== undefined) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				this.pending.delete(cancel);
			};
			const fail = (error: RpcClientError) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const cancel: Cancel = (error) => fail(error);
			const onAbort = () => fail(new RpcClientError("aborted", `RPC ${method} request was aborted.`));
			const onReply = (data: unknown) => {
				if (!isRecord(data) || data.requestId !== requestId) return;
				if (data.version !== SUBAGENT_RPC_PROTOCOL_VERSION) return fail(new RpcClientError("invalid_reply", "RPC reply has an unsupported version."));
				if (data.success === true) {
					if (settled) return;
					settled = true;
					cleanup();
					resolve(data.data as T);
				} else if (data.success === false && isRecord(data.error) && typeof data.error.code === "string") {
					fail(new RpcClientError(data.error.code, typeof data.error.message === "string" ? data.error.message : "RPC method failed."));
				} else fail(new RpcClientError("invalid_reply", "Malformed RPC reply envelope."));
			};
			if (options.signal?.aborted) return onAbort();
			offReply = this.events.on(subagentRpcReplyEvent(requestId), onReply);
			this.pending.add(cancel);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => fail(new RpcClientError("timeout", `RPC ${method} timed out after ${timeout}ms.`)), timeout);
			try {
				this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
					version: SUBAGENT_RPC_PROTOCOL_VERSION,
					requestId,
					method,
					...(params !== undefined ? { params } : {}),
					...(options.source ? { source: options.source } : {}),
				});
			} catch (error) {
				fail(new RpcClientError("transport_error", error instanceof Error ? error.message : String(error)));
			}
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (typeof this.offReady === "function") this.offReady();
		for (const cancel of [...this.pending]) cancel(new RpcClientError("disposed", "RPC client is disposed."));
		this.pending.clear();
	}
}
