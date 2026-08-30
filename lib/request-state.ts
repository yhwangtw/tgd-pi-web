export type RequestStatus = "idle" | "loading" | "refreshing" | "success" | "error";

export interface RequestSnapshot<T> {
  status: RequestStatus;
  data: T | undefined;
  error: string | null;
  updatedAt: number | null;
  attempts: number;
}

export interface RequestLoadOptions {
  staleTimeMs?: number;
  retries?: number;
  retryDelayMs?: number;
  force?: boolean;
}

type RequestFetcher<T> = (signal: AbortSignal) => Promise<T>;
type Listener = () => void;

interface RequestEntry<T = unknown> {
  snapshot: RequestSnapshot<T>;
  listeners: Set<Listener>;
  controller: AbortController | null;
  task: Promise<T> | null;
}

const DEFAULT_STALE_TIME_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 300;
const EMPTY_SNAPSHOT: RequestSnapshot<never> = Object.freeze({
  status: "idle",
  data: undefined,
  error: null,
  updatedAt: null,
  attempts: 0,
});

const entries = new Map<string, RequestEntry>();

function entryFor<T>(key: string): RequestEntry<T> {
  const current = entries.get(key) as RequestEntry<T> | undefined;
  if (current) return current;
  const created: RequestEntry<T> = {
    snapshot: EMPTY_SNAPSHOT as RequestSnapshot<T>,
    listeners: new Set(),
    controller: null,
    task: null,
  };
  entries.set(key, created as RequestEntry);
  return created;
}

function emit<T>(entry: RequestEntry<T>, snapshot: RequestSnapshot<T>): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function emptyRequestSnapshot<T>(): RequestSnapshot<T> {
  return EMPTY_SNAPSHOT as RequestSnapshot<T>;
}

export function getRequestSnapshot<T>(key: string): RequestSnapshot<T> {
  return entryFor<T>(key).snapshot;
}

export function subscribeRequest(key: string, listener: Listener): () => void {
  const entry = entryFor(key);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && entry.task) {
      // React StrictMode intentionally unsubscribes and immediately subscribes
      // again while probing effects in development. Aborting synchronously
      // leaves the second mount attached to the already-aborted task and the
      // resource can remain permanently idle. Defer one microtask and recheck
      // ownership so real unmounts still cancel promptly without breaking the
      // replacement subscriber.
      const task = entry.task;
      queueMicrotask(() => {
        if (entry.listeners.size === 0 && entry.task === task) entry.controller?.abort();
      });
    }
  };
}

export function loadRequest<T>(
  key: string,
  fetcher: RequestFetcher<T>,
  options: RequestLoadOptions = {},
): Promise<T> {
  const entry = entryFor<T>(key);
  if (entry.task) return entry.task;

  const staleTimeMs = options.staleTimeMs ?? DEFAULT_STALE_TIME_MS;
  const updatedAt = entry.snapshot.updatedAt;
  const hasFreshData = entry.snapshot.status === "success"
    && updatedAt !== null
    && Date.now() - updatedAt < staleTimeMs;
  if (!options.force && hasFreshData) return Promise.resolve(entry.snapshot.data as T);

  const controller = new AbortController();
  entry.controller = controller;
  emit(entry, {
    ...entry.snapshot,
    status: entry.snapshot.data === undefined ? "loading" : "refreshing",
    error: null,
    attempts: 0,
  });

  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const task = (async () => {
    let attempt = 0;
    try {
      while (true) {
        attempt += 1;
        emit(entry, { ...entry.snapshot, attempts: attempt });
        try {
          const data = await fetcher(controller.signal);
          emit(entry, {
            status: "success",
            data,
            error: null,
            updatedAt: Date.now(),
            attempts: attempt,
          });
          return data;
        } catch (error) {
          if (aborted(error) || controller.signal.aborted) throw error;
          if (attempt > retries) throw error;
          await wait(retryDelayMs * (2 ** (attempt - 1)), controller.signal);
        }
      }
    } catch (error) {
      if (aborted(error) || controller.signal.aborted) {
        emit(entry, {
          ...entry.snapshot,
          status: entry.snapshot.data === undefined ? "idle" : "success",
          error: null,
        });
      } else {
        emit(entry, {
          ...entry.snapshot,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  })();
  entry.task = task;
  const release = () => {
    if (entry.task === task) {
      entry.task = null;
      entry.controller = null;
    }
  };
  void task.then(release, release);
  return task;
}

export function invalidateRequest(key: string, dropData = false): void {
  const entry = entryFor(key);
  emit(entry, {
    ...entry.snapshot,
    status: dropData ? "idle" : entry.snapshot.data === undefined ? "idle" : "success",
    data: dropData ? undefined : entry.snapshot.data,
    error: null,
    updatedAt: null,
    attempts: 0,
  });
}

export function setRequestData<T>(key: string, data: T): void {
  const entry = entryFor<T>(key);
  emit(entry, { status: "success", data, error: null, updatedAt: Date.now(), attempts: 0 });
}

export function resetRequestState(): void {
  for (const entry of entries.values()) entry.controller?.abort();
  entries.clear();
}
