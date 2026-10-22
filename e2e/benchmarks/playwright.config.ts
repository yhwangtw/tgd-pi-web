import path from "node:path";
import { realpathSync } from "node:fs";
import base from "../../playwright.config";
import { createStreamingBenchmarkFixture } from "../../scripts/streaming-benchmark-fixture.mjs";

// Separate opt-in suite: never changes the normal regression fixture's model catalog.
if (!process.env.PI_STREAM_BENCHMARK_READY) {
  createStreamingBenchmarkFixture(realpathSync(process.env.E2E_ROOT!));
  process.env.PI_STREAM_BENCHMARK_READY = "1";
}
const source = path.resolve(__dirname, "../..");
export default {
  ...base,
  testDir: __dirname,
  testMatch: "**/*.benchmark.ts",
  globalSetup: path.join(source, "e2e/global-setup.ts"),
  outputDir: process.env.PI_STREAM_BENCHMARK_OUTPUT || path.join(source, "test-results/streaming-benchmark"),
  timeout: 120_000,
  retries: 0,
  webServer: {
    ...base.webServer,
    cwd: source,
    // The caller must build this isolated candidate first. Never rebuild a live checkout.
    command: `npm run start -- -p ${process.env.E2E_PORT || 30177}`,
  },
};
