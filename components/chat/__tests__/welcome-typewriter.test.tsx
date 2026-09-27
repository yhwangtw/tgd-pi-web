// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WelcomeTypewriter } from "../WelcomeTypewriter";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const phrases = ["Ready to help.", "Explore your code."];
let reduced = true;
const listeners = new Set<() => void>();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.useFakeTimers();
  reduced = true;
  vi.stubGlobal("matchMedia", () => ({
    matches: reduced,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  listeners.clear();
});

it("renders a complete static phrase on the server and with reduced motion, without timers", () => {
  expect(renderToString(<WelcomeTypewriter phrases={phrases} />)).toContain("Ready to help.");
  act(() => root.render(<WelcomeTypewriter phrases={phrases} />));
  expect(host.textContent).toBe("Ready to help.");
  expect(host.querySelector('[aria-hidden="true"]')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("responds to preference changes and cancels typing and blinking immediately", () => {
  reduced = false;
  act(() => root.render(<WelcomeTypewriter phrases={phrases} />));
  expect(vi.getTimerCount()).toBe(2);
  act(() => vi.advanceTimersByTime(1800));
  act(() => vi.advanceTimersByTime(28));
  expect(host.textContent).not.toBe("Ready to help.▍");

  act(() => { reduced = true; listeners.forEach((listener) => listener()); });
  expect(host.textContent).toBe("Ready to help.");
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(10_000));
  expect(host.textContent).toBe("Ready to help.");

  act(() => { reduced = false; listeners.forEach((listener) => listener()); });
  expect(vi.getTimerCount()).toBe(2);
  act(() => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
  expect(listeners.size).toBe(0);
});
