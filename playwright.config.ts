import { defineConfig } from "@playwright/test";
import path from "path";
import os from "os";
import { mkdtempSync } from "fs";
import { createFixtures } from "./e2e/fixtures";

// Allocate a new fixture child for each invocation. Workers share the run root
// through env; E2E_ROOT can select a parent but is never erased or reused.
const E2E_ROOT = process.env.PI_E2E_RUN_ROOT ?? mkdtempSync(path.join(process.env.E2E_ROOT ?? os.tmpdir(), "pi-web-e2e-"));
// Playwright starts webServer BEFORE globalSetup. Seed the empty directory
// here, before the server can initialize its agent stores. Worker config
// reloads inherit the root and must not regenerate it.
if (!process.env.PI_E2E_RUN_ROOT) {
  createFixtures(E2E_ROOT);
  process.env.PI_E2E_FIXTURES_READY = E2E_ROOT;
}
process.env.PI_E2E_RUN_ROOT = E2E_ROOT;
const E2E_PORT = Number(process.env.E2E_PORT ?? 30177);
process.env.E2E_ROOT = E2E_ROOT;
process.env.E2E_PROJECT_CWD = path.join(E2E_ROOT, "demo-project");

// The suite builds and boots a production server on a dedicated port with
// PI_CODING_AGENT_DIR pointing at generated fixtures. NOTE: `next build`
// corrupts a concurrently running dev server's .next — stop `npm run dev`
// before running the E2E suite locally.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // specs share one server + one session store
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    // Local containers with preinstalled browsers can point this at the
    // binary (e.g. /opt/pw-browsers/chromium); CI uses the managed download.
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    },
  },
  webServer: {
    command: `npm run build && npx next start -H 127.0.0.1 -p ${E2E_PORT}`,
    port: E2E_PORT,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      PI_CODING_AGENT_DIR: path.join(E2E_ROOT, "agent"),
    },
  },
});
