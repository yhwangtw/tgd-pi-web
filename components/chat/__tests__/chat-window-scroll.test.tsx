// @vitest-environment jsdom
// Exercise the real ChatWindow scroll effects and hook with isolated session state.
// jsdom has no layout engine; geometry models a growing tail below a 600px viewport.
import { act, memo, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatWindow } from "@/components/chat/ChatWindow";
import { useTranscriptScroll } from "@/hooks/use-transcript-scroll";
import { resetScrollFollowModeCache, setScrollFollowMode } from "@/lib/prefs";
import type { useAgentSession } from "@/hooks/useAgentSession";
import type { AssistantMessage } from "@/lib/types";

type SessionFixture = Pick<ReturnType<typeof useAgentSession>,
  "messages" | "entryIds" | "streamState" | "agentRunning" | "extensionUIState" |
  "modelNames" | "modelList" | "modelThinkingLevels" | "modelThinkingLevelMaps" |
  "compactionQueue" | "queuedFollowUps" | "runProgress" | "bashRun" | "loading">;

const fixture = vi.hoisted(() => ({
  state: {} as SessionFixture,
  messageRenders: new Map<string, number>(),
  getGenerationMetrics: vi.fn(() => undefined),
  openQuote: null as ((entryId: string) => void) | null,
  quote: null as { entryId: string; role: "user" | "assistant"; text: string } | null,
}));
vi.mock("@/hooks/useAgentSession", () => ({ useAgentSession: () => {
  const running = useRef(fixture.state.agentRunning); running.current = fixture.state.agentRunning;
  const refs = useTranscriptScroll(fixture.state.messages.length, fixture.state.agentRunning, running);
  const handler = useRef(null);
  return { ...fixture.state, ...refs, handleAgentEventRef: handler, getGenerationMetrics: fixture.getGenerationMetrics };
} }));
vi.mock("@/hooks/useAudio", () => ({ useAudio: () => ({ soundEnabled: false }) }));
vi.mock("@/components/chat/ChatInput", () => ({ ChatInput: ({ quote, onOpenQuote }: { quote?: typeof fixture.quote; onOpenQuote?: (entryId: string) => void }) => {
  fixture.openQuote = onOpenQuote ?? null;
  fixture.quote = quote ?? null;
  return null;
} }));
vi.mock("@/components/chat/MessageView", () => ({ MessageView: memo(function MockMessageView(props: {
  entryId?: string;
  message: { role: string };
  onQuote?: (entryId: string, role: string, text: string) => void;
}) {
  if (props.entryId) fixture.messageRenders.set(props.entryId, (fixture.messageRenders.get(props.entryId) ?? 0) + 1);
  return <button data-quote-entry={props.entryId} onClick={() => props.onQuote?.(props.entryId!, props.message.role, "quoted text")}>message</button>;
}) }));
vi.mock("@/components/chat/AssistantMessageView", () => ({ isProviderAuthError: () => false }));
vi.mock("@/components/chat/ExtensionUIPanel", () => ({ ExtensionUIPanel: () => null, ExtensionWidgets: () => null, PendingQuestionNotice: () => null }));
vi.mock("@/components/chat/UserQuestionCard", () => ({ UserQuestionCard: () => null }));
vi.mock("@/components/chat/ChatMinimap", () => ({ ChatMinimap: () => null, useMessageRefs: () => useRef([]) }));
vi.mock("@/components/chat/BashBlock", () => ({ BashBlock: () => <div>bash</div> }));
vi.mock("@/components/chat/CollapsibleMessage", () => ({ CollapsibleMessage: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/chat/TgdPipeline", () => ({ TgdPipeline: () => null }));
vi.mock("@/components/chat/QueuedFollowUps", () => ({ QueuedFollowUps: () => null }));
vi.mock("@/components/chat/CompactionStatus", () => ({ CompactionStatus: () => null }));
vi.mock("@/components/chat/ProviderRecoveryBanner", () => ({ ProviderRecoveryBanner: () => null }));
vi.mock("@/components/chat/RunStatus", () => ({ RunStatus: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let markerTop = 600;
let contentHeight = 1800;
const resizeObservers = new Set<ResizeObserverStub>();
class ResizeObserverStub {
  constructor(private callback: ResizeObserverCallback) { resizeObservers.add(this); }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn(() => resizeObservers.delete(this));
  fire() { this.callback([], this); }
}
async function resize() {
  await act(async () => {
    resizeObservers.forEach((observer) => observer.fire());
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
let scrollIntoView: ReturnType<typeof vi.fn>;
const answer = (text: string): AssistantMessage => ({ role: "assistant", model: "fixture", provider: "fixture", content: [{ type: "text", text }], timestamp: 1, stopReason: "stop" });
const render = async () => { await act(async () => root.render(<ChatWindow session={null} newSessionCwd={null} />)); };
const scroller = () => host.querySelector("[data-transcript-scroll]")!;

beforeEach(() => {
  localStorage.clear(); resetScrollFollowModeCache(); fixture.messageRenders.clear(); fixture.quote = null; fixture.openQuote = null;
  markerTop = 600; contentHeight = 1800;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  fixture.state = {
    messages: [{ role: "user", content: "Question", timestamp: 1 }], entryIds: ["user1"],
    streamState: { isStreaming: true, streamingMessage: answer("partial") },
    agentRunning: true, extensionUIState: { dialogs: [], widgets: {}, statuses: {} },
    modelNames: {}, modelList: [], modelThinkingLevels: {}, modelThinkingLevelMaps: {},
    compactionQueue: [], queuedFollowUps: [], loading: false, bashRun: null, runProgress: { idleSeconds: 0, attention: "normal", connection: "connected" },
  };
  scrollIntoView = vi.fn(() => { markerTop = 600; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { top: this.hasAttribute("data-transcript-scroll") ? 0 : markerTop, bottom: 600, height: 600, width: 800, x: 0, y: 0, left: 0, right: 800, toJSON() {} };
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => contentHeight });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resizeObservers.clear(); });

it("follows a growing text stream", async () => {
  await render(); scrollIntoView.mockClear(); markerTop = 800;
  fixture.state.streamState = { isStreaming: true, streamingMessage: answer("longer") };
  await render(); expect(scrollIntoView).toHaveBeenCalled();
});
it("does not mark background messages read until the transcript becomes visible", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  fixture.state.messages = [answer("A newly delivered reply")];
  fixture.state.entryIds = ["unseen-answer"];
  fixture.state.streamState = { isStreaming: false, streamingMessage: null };
  fixture.state.agentRunning = false;
  await act(async () => root.render(<ChatWindow session={{
    id: "read-visibility", path: "", cwd: "/fixture", created: "", modified: "",
    messageCount: 1, firstMessage: "Question",
  }} newSessionCwd={null} />));
  markerTop = 100;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(localStorage.getItem("pi-session-read:read-visibility")).toBeNull();
  visibility.mockReturnValue("visible");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(localStorage.getItem("pi-session-read:read-visibility")).toBe("1");
  expect(localStorage.getItem("pi-last-read:read-visibility")).toBe("unseen-answer");
});
it("follows the final committed message after the last throttled frame", async () => {
  await render(); scrollIntoView.mockClear(); markerTop = 800;
  fixture.state.messages = [...fixture.state.messages, answer("complete with final chunk")];
  fixture.state.streamState = { isStreaming: false, streamingMessage: null };
  await render(); expect(scrollIntoView).toHaveBeenCalled(); expect(host.querySelector('[aria-label="Jump to bottom"]')).toBeNull();
});
it("keeps an engaged smart reader at the tail when the run finishes", async () => {
  await render(); scrollIntoView.mockClear(); markerTop = 800;
  fixture.state.messages = [...fixture.state.messages, answer("complete with final chunk")];
  fixture.state.streamState = { isStreaming: false, streamingMessage: null }; fixture.state.agentRunning = false;
  await render(); expect(scrollIntoView).toHaveBeenCalled();
});
it("follows bash output even in always mode", async () => {
  localStorage.setItem("pi-scroll-follow-mode", "always"); resetScrollFollowModeCache();
  fixture.state.streamState = { isStreaming: false, streamingMessage: null };
  fixture.state.bashRun = { command: "fixture", output: "line1", running: true };
  await render(); scrollIntoView.mockClear(); markerTop = 800;
  fixture.state.bashRun = { command: "fixture", output: "line1\nline2", running: true };
  await render(); expect(scrollIntoView).toHaveBeenCalled();
});
it("upward wheel pauses smart follow", async () => {
  await render(); scrollIntoView.mockClear(); markerTop = 900;
  await act(async () => { scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -200 })); scroller().dispatchEvent(new Event("scroll")); });
  fixture.state.streamState = { isStreaming: true, streamingMessage: answer("longer") };
  await render(); expect(scrollIntoView).not.toHaveBeenCalled();
});
it("Latest resumes smart follow for subsequent text", async () => {
  await render(); markerTop = 900;
  await act(async () => { scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -200 })); scroller().dispatchEvent(new Event("scroll")); });
  const latest = host.querySelector<HTMLButtonElement>('button[aria-label="Jump to bottom"]')!;
  expect(latest).not.toBeNull(); await act(async () => latest.click()); scrollIntoView.mockClear(); markerTop = 900;
  fixture.state.streamState = { isStreaming: true, streamingMessage: answer("longer") };
  await render(); expect(scrollIntoView).toHaveBeenCalled();
});


it("follows tool-result commits while no text stream is active", async () => {
  fixture.state.messages.push({ ...answer(""), content: [{ type: "toolCall", toolCallId: "tool1", toolName: "read", input: { path: "fixture.txt" } }] });
  fixture.state.streamState = { isStreaming: false, streamingMessage: null };
  await render(); scrollIntoView.mockClear(); markerTop = 800;
  fixture.state.messages = [...fixture.state.messages, { role: "toolResult", toolCallId: "tool1", content: [{ type: "text", text: "result" }] }];
  await render(); expect(scrollIntoView).toHaveBeenCalled();
});

it("keeps a paused reader in place through final message, completion and late layout", async () => {
  await render(); markerTop = 900;
  await act(async () => { scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -200 })); scroller().dispatchEvent(new Event("scroll")); });
  scrollIntoView.mockClear();
  fixture.state.messages = [...fixture.state.messages, answer("complete")];
  fixture.state.streamState = { isStreaming: false, streamingMessage: null };
  await render(); fixture.state.agentRunning = false; await render();
  markerTop = 1000; await resize();
  expect(scrollIntoView).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Jump to bottom"]')).not.toBeNull();
});

it("keeps preserve mode stationary for text, commits and bash output", async () => {
  localStorage.setItem("pi-scroll-follow-mode", "preserve"); resetScrollFollowModeCache();
  await render(); scrollIntoView.mockClear(); markerTop = 800;
  fixture.state.streamState = { isStreaming: true, streamingMessage: answer("longer") }; await render();
  fixture.state.messages = [...fixture.state.messages, answer("complete")];
  fixture.state.streamState = { isStreaming: false, streamingMessage: null }; await render();
  fixture.state.bashRun = { command: "fixture", output: "output", running: true }; await render();
  fixture.state.agentRunning = false; await render(); await resize();
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it("updates Latest and unread lines for paused bash output", async () => {
  localStorage.setItem("pi-scroll-follow-mode", "preserve"); resetScrollFollowModeCache();
  await render(); scrollIntoView.mockClear(); markerTop = 900; contentHeight += 240;
  fixture.state.bashRun = { command: "fixture", output: "output", running: true };
  await render();
  expect(host.querySelector('[aria-label="Jump to bottom"]')?.textContent).toContain("+10");
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it("follows late content layout after completion and hides Latest", async () => {
  await render(); fixture.state.agentRunning = false;
  fixture.state.streamState = { isStreaming: false, streamingMessage: null }; await render();
  scrollIntoView.mockClear(); markerTop = 900; await resize();
  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "end" });
  expect(host.querySelector('[aria-label="Jump to bottom"]')).toBeNull();
});

it("applies preserve mode immediately to late layout in an idle conversation", async () => {
  await render(); fixture.state.agentRunning = false;
  fixture.state.streamState = { isStreaming: false, streamingMessage: null }; await render();
  await act(async () => setScrollFollowMode("preserve"));
  scrollIntoView.mockClear(); markerTop = 900; await resize();
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it("keeps a short reply at its top anchor without scrolling into the spacer", async () => {
  await render(); scrollIntoView.mockClear(); markerTop = 350;
  fixture.state.streamState = { isStreaming: true, streamingMessage: answer("short") }; await render();
  await resize(); expect(scrollIntoView).not.toHaveBeenCalled();
});

it("attaches layout observation when a loading transcript becomes visible", async () => {
  fixture.state.loading = true; await render();
  expect(resizeObservers.size).toBe(0);
  fixture.state.loading = false; await render();
  scrollIntoView.mockClear(); markerTop = 900; await resize();
  expect(scrollIntoView).toHaveBeenCalled();
});

it("cancels queued layout work when the transcript unmounts", async () => {
  await render(); scrollIntoView.mockClear(); markerTop = 900;
  await act(async () => { resizeObservers.forEach((observer) => observer.fire()); root.render(null); });
  await resize(); expect(resizeObservers.size).toBe(0); expect(scrollIntoView).not.toHaveBeenCalled();
});


it("pauses smart follow for turn or minimap navigation without a wheel event", async () => {
  await render();
  await act(async () => { scroller().scrollTop = 400; scroller().dispatchEvent(new Event("scroll")); });
  markerTop = 1000;
  await act(async () => { scroller().scrollTop = 100; scroller().dispatchEvent(new Event("scroll")); });
  scrollIntoView.mockClear(); await resize();
  fixture.state.messages = [...fixture.state.messages, answer("complete")];
  fixture.state.streamState = { isStreaming: false, streamingMessage: null }; await render();
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it("does not cancel a small upward-wheel pause just because the tail is near", async () => {
  await render();
  await act(async () => { scroller().scrollTop = 400; scroller().dispatchEvent(new Event("scroll")); });
  markerTop = 650;
  await act(async () => {
    scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
    scroller().scrollTop = 350; scroller().dispatchEvent(new Event("scroll"));
  });
  scrollIntoView.mockClear(); markerTop = 900;
  fixture.state.streamState = { isStreaming: true, streamingMessage: answer("longer") }; await render();
  expect(scrollIntoView).not.toHaveBeenCalled();
  markerTop = 600;
  await act(async () => { scroller().scrollTop = 650; scroller().dispatchEvent(new Event("scroll")); });
  markerTop = 900; await resize(); expect(scrollIntoView).toHaveBeenCalled();
});

it("keeps historical message views memoized during token updates and scopes quotes to their entry", async () => {
  fixture.state.messages = [{ role: "user", content: "Earlier question" }, answer("Earlier answer"), { role: "user", content: "Current question" }];
  fixture.state.entryIds = ["earlier-user", "earlier-answer", "current-user"];
  await render();
  const before = new Map(fixture.messageRenders);
  fixture.state.streamState = { isStreaming: true, streamingMessage: answer("The next streaming token") };
  await render();
  expect(fixture.messageRenders).toEqual(before);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-quote-entry="earlier-answer"]')!.click());
  expect(fixture.quote).toEqual({ entryId: "earlier-answer", role: "assistant", text: "quoted text" });
});


it("does not rebuild a thousand historical row elements for token-only frames", async () => {
  fixture.state.messages = Array.from({ length: 1000 }, (_, i) => i % 2
    ? answer(`Answer ${i}`) : { role: "user" as const, content: `Question ${i}`, timestamp: i });
  fixture.state.entryIds = fixture.state.messages.map((_, i) => `entry-${i}`);
  await render();
  fixture.getGenerationMetrics.mockClear();
  fixture.messageRenders.clear();
  for (let i = 0; i < 10; i++) {
    fixture.state.streamState = { isStreaming: true, streamingMessage: answer(`Partial ${i}`) };
    await render();
  }
  expect(fixture.getGenerationMetrics).not.toHaveBeenCalled();
  expect(fixture.messageRenders.size).toBe(0);
});


it("mounts the latest 200 messages then reveals an older quote without losing history", async () => {
  fixture.state.messages = Array.from({ length: 1000 }, (_, i) => i % 2
    ? answer(`Answer ${i}`) : { role: "user" as const, content: `Question ${i}`, timestamp: i });
  fixture.state.entryIds = fixture.state.messages.map((_, i) => `entry-${i}`);
  const animate = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  await render();
  expect(host.querySelectorAll(".msg-item")).toHaveLength(200);
  expect(host.querySelector('[data-entry-id="entry-0"]')).toBeNull();
  expect(host.textContent).toContain("Load earlier messages (800)");
  await act(async () => {
    fixture.openQuote!("entry-0");
  });
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  expect(host.querySelectorAll(".msg-item")).toHaveLength(1000);
  expect(host.querySelector('[data-entry-id="entry-0"]')).not.toBeNull();
  expect(animate).toHaveBeenCalled();
  // Explicit old-history navigation must remain paused after prepend settles.
  // Its initial auto-scroll event may occur while anchor handling is suspended.
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  scrollIntoView.mockClear(); markerTop = 900;
  fixture.state.streamState = { isStreaming: true, streamingMessage: answer("Next token") };
  await render();
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it("loads earlier history in 200-message batches and Home reveals the logical first message", async () => {
  fixture.state.messages = Array.from({ length: 1000 }, (_, i) => ({ role: "user" as const, content: `Question ${i}`, timestamp: i }));
  fixture.state.entryIds = fixture.state.messages.map((_, i) => `entry-${i}`);
  await render();
  const earlier = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Load earlier messages"))!;
  await act(async () => earlier.click());
  expect(host.querySelectorAll(".msg-item")).toHaveLength(400);
  const first = host.querySelector<HTMLElement>('[data-entry-id="entry-600"]')!;
  await act(async () => {
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  });
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  expect(host.querySelectorAll(".msg-item")).toHaveLength(1000);
  expect(document.activeElement).toBe(host.querySelector('[data-entry-id="entry-0"]'));
});


it("searches unmounted messages and navigates only after the matching row commits", async () => {
  fixture.state.messages = Array.from({ length: 500 }, (_, i) => ({ role: "user" as const, content: `Question ${i}`, timestamp: i }));
  fixture.state.entryIds = fixture.state.messages.map((_, i) => `entry-${i}`);
  vi.stubGlobal("CSS", {});
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: vi.fn() });
  await render();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true })));
  const input = host.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Question 0");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("1/1");
  expect(host.querySelector('[data-entry-id="entry-0"]')).toBeNull();
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  expect(host.querySelector('[data-entry-id="entry-0"]')).not.toBeNull();
});

it("keeps old bookmarks and the unread boundary reachable before earlier messages mount", async () => {
  fixture.state.messages = Array.from({ length: 500 }, (_, i) => ({ role: "user" as const, content: `Question ${i}`, timestamp: i }));
  fixture.state.entryIds = fixture.state.messages.map((_, i) => `entry-${i}`);
  localStorage.setItem("pi-bookmarks:history-navigation", JSON.stringify(["entry-20"]));
  localStorage.setItem("pi-last-read:history-navigation", "entry-9");
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: vi.fn() });
  await act(async () => root.render(<ChatWindow session={{
    id: "history-navigation", path: "", cwd: "/fixture", created: "", modified: "",
    messageCount: 500, firstMessage: "Question 0",
  }} newSessionCwd={null} />));
  const bookmark = host.querySelector<HTMLButtonElement>('[aria-label="Jump to earlier bookmarks"]')!;
  const unread = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "New since your last visit")!;
  expect(bookmark).not.toBeNull();
  expect(unread).toBeDefined();
  await act(async () => unread.click());
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  expect(host.querySelector('[data-entry-id="entry-10"]')).not.toBeNull();
  expect(host.querySelector('[data-entry-id="entry-20"][data-bookmarked]')).not.toBeNull();
  expect(host.querySelector('[role="separator"]')?.textContent).toBe("New since your last visit");
});
