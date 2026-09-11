import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Runs before every test file (and before its imports). Route tests must never
// resolve Pi's default stores to the developer's real ~/.pi/agent directory.
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-web-unit-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;

// Newer Node versions expose host Web Storage globals. Vitest preserves those
// globals when installing jsdom, but UI tests must use this document's storage,
// never a host file or a process-wide session store. Node-only tests are unchanged.
const browser = (globalThis as typeof globalThis & { jsdom?: { window: Window } }).jsdom?.window;
const storageDescriptors = new Map<string, PropertyDescriptor | undefined>();
if (browser) {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    storageDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: browser[name] });
  }
}

afterAll(() => {
  for (const [name, descriptor] of storageDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  // Keep late asynchronous callbacks confined too. Restoring the real agent
  // directory here would let a delayed timer write production data after tests.
  rmSync(isolatedAgentDir, { recursive: true, force: true });
});
