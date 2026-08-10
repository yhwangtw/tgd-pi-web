#!/usr/bin/env node

const baseUrl = process.env.PIWEB_URL || "http://127.0.0.1:30141";
const intervalMs = Math.max(15_000, Number(process.env.PIWEB_SCHEDULER_WATCHDOG_MS) || 60_000);

async function wake() {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/schedules/wake`, { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    process.stdout.write(`[scheduler-watchdog] ${new Date().toISOString()} ${payload.health?.state ?? "ok"}\n`);
  } catch (error) {
    process.stderr.write(`[scheduler-watchdog] ${new Date().toISOString()} ${error instanceof Error ? error.message : error}\n`);
  }
}

await wake();
if (!process.argv.includes("--once")) setInterval(wake, intervalMs);
