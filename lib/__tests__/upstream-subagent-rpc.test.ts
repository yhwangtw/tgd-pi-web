import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SUBAGENT_RPC_PROTOCOL_VERSION,
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_RPC_REQUEST_EVENT,
	SubagentRpcClient,
	RpcClientError,
	subagentRpcReplyEvent,
	type EventBus,
} from "../upstream-subagent-rpc";

class MockEventBus implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	readonly emitted: Array<{ event: string; data: unknown }> = [];

	on(event: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(event) ?? new Set();
		set.add(handler);
		this.handlers.set(event, set);
		return () => set.delete(handler);
	}

	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}

	listenerCount(event: string): number {
		return this.handlers.get(event)?.size ?? 0;
	}

	totalListeners(): number {
		let total = 0;
		for (const set of this.handlers.values()) total += set.size;
		return total;
	}
}

function ready(bus: MockEventBus, version = 1): void {
	bus.emit(SUBAGENT_RPC_READY_EVENT, { version, methods: ["ping", "status"] });
}

function lastRequest(bus: MockEventBus): { requestId: string; method: string; params?: unknown } {
	const request = bus.emitted.find((entry) => entry.event === SUBAGENT_RPC_REQUEST_EVENT);
	if (!request) throw new Error("no request emitted");
	return request.data as { requestId: string; method: string; params?: unknown };
}

function reply(bus: MockEventBus, requestId: string, data: unknown): void {
	bus.emit(subagentRpcReplyEvent(requestId), {
		version: SUBAGENT_RPC_PROTOCOL_VERSION,
		requestId,
		success: true,
		data,
	});
}

describe("SubagentRpcClient", () => {
	let bus: MockEventBus;
	let client: SubagentRpcClient;

	beforeEach(() => {
		vi.useFakeTimers();
		bus = new MockEventBus();
		client = new SubagentRpcClient(bus);
	});

	afterEach(() => {
		client.dispose();
		vi.useRealTimers();
	});

	it("subscribes to the reply channel before emitting the request", async () => {
		expect(bus.listenerCount(subagentRpcReplyEvent("known-id"))).toBe(0);
		const promise = client.request("ping", {}, { requestId: "known-id" });
		expect(bus.listenerCount(subagentRpcReplyEvent("known-id"))).toBe(1);
		const request = lastRequest(bus);
		expect(request).toMatchObject({ requestId: "known-id", method: "ping", params: {} });
		reply(bus, "known-id", { ok: true });
		await expect(promise).resolves.toEqual({ ok: true });
	});

	it("handles a synchronous reply emitted during the request emit (race)", async () => {
		class SyncReplyBus extends MockEventBus {
			override emit(event: string, data: unknown): void {
				super.emit(event, data);
				if (event !== SUBAGENT_RPC_REQUEST_EVENT) return;
				const requestId = (data as { requestId: string }).requestId;
				super.emit(subagentRpcReplyEvent(requestId), {
					version: 1,
					requestId,
					success: true,
					data: "sync",
				});
			}
		}
		const syncBus = new SyncReplyBus();
		const syncClient = new SubagentRpcClient(syncBus);
		await expect(syncClient.request("ping", {}, { requestId: "sync-1" })).resolves.toBe("sync");
		syncClient.dispose();
	});

	it("correlates replies by requestId and ignores other channels", async () => {
		const first = client.request("ping", undefined, { requestId: "first" });
		const second = client.request("status", { id: "run" }, { requestId: "second" });
		reply(bus, "other", "wrong");
		reply(bus, "second", { run: 2 });
		reply(bus, "first", { run: 1 });
		await expect(first).resolves.toEqual({ run: 1 });
		await expect(second).resolves.toEqual({ run: 2 });
	});

	it("surfaces method errors with the upstream error code and message", async () => {
		const promise = client.request("spawn", { agent: "worker" }, { requestId: "err-1" });
		bus.emit(subagentRpcReplyEvent("err-1"), {
			version: 1,
			requestId: "err-1",
			success: false,
			error: { code: "invalid_params", message: "agent is required" },
		});
		await expect(promise).rejects.toMatchObject({ code: "invalid_params", message: "agent is required" });
	});

	it("rejects unsupported reply versions", async () => {
		const promise = client.request("ping", undefined, { requestId: "bad-version" });
		bus.emit(subagentRpcReplyEvent("bad-version"), {
			version: 2,
			requestId: "bad-version",
			success: true,
			data: {},
		});
		await expect(promise).rejects.toBeInstanceOf(RpcClientError);
		await expect(promise).rejects.toMatchObject({ code: "invalid_reply" });
	});

	it("times out and removes its reply listener", async () => {
		const promise = client.request("status", undefined, { requestId: "slow", timeoutMs: 50 });
		expect(bus.listenerCount(subagentRpcReplyEvent("slow"))).toBe(1);
		vi.advanceTimersByTime(50);
		await expect(promise).rejects.toMatchObject({ code: "timeout" });
		expect(bus.listenerCount(subagentRpcReplyEvent("slow"))).toBe(0);
	});

	it("cleans up on abort and ignores late replies", async () => {
		const controller = new AbortController();
		const promise = client.request("status", undefined, { requestId: "abort-1", signal: controller.signal });
		controller.abort();
		await expect(promise).rejects.toMatchObject({ code: "aborted" });
		expect(bus.listenerCount(subagentRpcReplyEvent("abort-1"))).toBe(0);
		reply(bus, "abort-1", "late");
	});

	it("disposes all pending requests and the readiness listener", async () => {
		const promise = client.request("status", undefined, { requestId: "pending" });
		expect(bus.listenerCount(SUBAGENT_RPC_READY_EVENT)).toBe(1);
		client.dispose();
		await expect(promise).rejects.toMatchObject({ code: "disposed" });
		expect(bus.listenerCount(subagentRpcReplyEvent("pending"))).toBe(0);
		expect(bus.totalListeners()).toBe(0);
	});

	it("resolves readiness and times out a later wait on a fresh client", async () => {
		expect(client.isReady()).toBe(false);
		const waiting = client.waitForReady(100);
		ready(bus);
		await expect(waiting).resolves.toMatchObject({ version: 1 });
		expect(client.isReady()).toBe(true);

		const freshBus = new MockEventBus();
		const freshClient = new SubagentRpcClient(freshBus);
		const timed = freshClient.waitForReady(100);
		vi.advanceTimersByTime(100);
		await expect(timed).rejects.toMatchObject({ code: "timeout" });
		expect(freshBus.listenerCount(SUBAGENT_RPC_READY_EVENT)).toBe(1);
		freshClient.dispose();
		expect(freshBus.totalListeners()).toBe(0);
	});

	it("requires readiness before sending when configured", async () => {
		const gated = new SubagentRpcClient(bus, { requireReady: true });
		const promise = gated.request("ping", undefined, { requestId: "gated", readyTimeoutMs: 100 });
		expect(bus.emitted.some((entry) => entry.event === SUBAGENT_RPC_REQUEST_EVENT)).toBe(false);
		ready(bus);
		await vi.advanceTimersByTimeAsync(0);
		expect(lastRequest(bus).requestId).toBe("gated");
		reply(bus, "gated", { pong: true });
		await expect(promise).resolves.toEqual({ pong: true });
		gated.dispose();
	});
});
