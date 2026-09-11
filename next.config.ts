import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";
import bundleAnalyzer from "@next/bundle-analyzer";
import { execFileSync } from 'node:child_process';

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let sourceSha = '';
let sourceDirty = '';
try {
  sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  sourceDirty = String(Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()));
} catch { /* Source archives have no Git identity; never invent one. */ }
const builtAt = new Date().toISOString();
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  // Never infer the workspace from lockfiles in parent directories. Without
  // these roots, a stray ~/package-lock.json can make output tracing scan the
  // entire home directory and make builds appear to hang.
  outputFileTracingRoot: __dirname,
  turbopack: {
    root: __dirname,
  },
  // The dev-tools badge floats bottom-left, exactly over the icon rail's
  // bottom buttons (Models/Theme) — disable it.
  devIndicators: false,
  serverExternalPackages: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
  allowedDevOrigins: ['192.168.*.*'],
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
    PIWEB_BUILD_SHA: sourceSha,
    PIWEB_BUILD_DIRTY: sourceDirty,
    PIWEB_BUILD_TIME: builtAt,
  },
};

export default withBundleAnalyzer(nextConfig);
