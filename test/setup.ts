import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Runs before every test file (and before its imports). Route tests must never
// resolve Pi's default stores to the developer's real ~/.pi/agent directory.
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-web-unit-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;

afterAll(() => {
  // Keep late asynchronous callbacks confined too. Restoring the real agent
  // directory here would let a delayed timer write production data after tests.
  rmSync(isolatedAgentDir, { recursive: true, force: true });
});
