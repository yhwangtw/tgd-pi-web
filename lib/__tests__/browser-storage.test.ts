// @vitest-environment jsdom

import { expect, it } from "vitest";

it.each(["localStorage", "sessionStorage"] as const)("uses the isolated browser %s instead of Node's host storage", (name) => {
  const browser = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window;
  expect(globalThis[name]).toBe(browser[name]);
  const key = "pi-storage-isolation-check";
  globalThis[name].setItem(key, "browser only");
  expect(browser[name].getItem(key)).toBe("browser only");
  globalThis[name].removeItem(key);
});
