import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export interface RuntimeStatusReport {
  checkedAt: string;
  web: { version: string };
  embeddedPi: { package: string; version: string; current: boolean | null };
  globalCli: { available: boolean; version?: string; current: boolean | null; error?: string };
  latest: { version?: string; releaseUrl: string; error?: string };
  commands: { updateGlobal: string; updateProject: string };
}

type LatestCache = { at: number; version?: string; error?: string };

declare global { var __piLatestVersionCache: LatestCache | undefined }

async function jsonVersion(path: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: string };
  return parsed.version ?? "unknown";
}

async function latestVersion(): Promise<LatestCache> {
  const current = globalThis.__piLatestVersionCache;
  if (current && Date.now() - current.at < 5 * 60_000) return current;
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PI_PACKAGE)}/latest`, {
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Registry HTTP ${response.status}`);
    const body = await response.json() as { version?: string };
    if (!body.version) throw new Error("Registry response has no version");
    return globalThis.__piLatestVersionCache = { at: Date.now(), version: body.version };
  } catch (error) {
    return globalThis.__piLatestVersionCache = { at: Date.now(), error: error instanceof Error ? error.message : String(error) };
  }
}

async function globalCliVersion(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("pi", ["--version"], { timeout: 4_000 });
    const output = `${stdout}\n${stderr}`.trim();
    const version = output.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0];
    return version ? { available: true, version } : { available: true, error: `Unrecognized version output: ${output.slice(0, 160)}` };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getRuntimeStatus(): Promise<RuntimeStatusReport> {
  const [webVersion, embeddedVersion, latest, globalCli] = await Promise.all([
    jsonVersion(join(process.cwd(), "package.json")),
    jsonVersion(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json")),
    latestVersion(),
    globalCliVersion(),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    web: { version: webVersion },
    embeddedPi: {
      package: PI_PACKAGE,
      version: embeddedVersion,
      current: latest.version ? embeddedVersion === latest.version : null,
    },
    globalCli: {
      ...globalCli,
      current: latest.version && globalCli.version ? globalCli.version === latest.version : null,
    },
    latest: {
      version: latest.version,
      releaseUrl: "https://github.com/earendil-works/pi/releases",
      error: latest.error,
    },
    commands: {
      updateGlobal: `npm install -g ${PI_PACKAGE}@latest`,
      updateProject: `npm install ${PI_PACKAGE}@latest @earendil-works/pi-ai@latest`,
    },
  };
}
