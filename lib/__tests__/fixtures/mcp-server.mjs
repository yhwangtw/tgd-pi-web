// A real, dependency-free JSON-RPC subprocess for MCP lifecycle regressions.
// Its only files and child processes belong to the test's fresh temporary root.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";

const [mode, logPath] = process.argv.slice(2);
if (!mode || !logPath) throw new Error("MCP fixture requires mode and log path");
const log = (event) => appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...event }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
log({ type: "start" });
if (mode === "stubborn") {
  setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {});
}
let changed = false;
const tool = (name) => ({ name, inputSchema: { type: "object", properties: {} } });
const outputSchema = { type: "object", properties: { count: { type: "number" } }, required: ["count"] };

async function handle(message) {
  log({ type: "request", method: message.method, params: message.params });
  const reply = (result) => send({ id: message.id, result });
  if (message.method === "initialize") {
    if (mode === "hang-initialize") return;
    if (mode === "stderr") {
      // Larger than both OS pipe and PassThrough high-water marks. Honor
      // backpressure so an undrained client really cannot reach initialize.
      for (let i = 0; i < 64; i++) {
        if (!process.stderr.write(Buffer.alloc(64 * 1024, "x"))) await once(process.stderr, "drain");
      }
    }
    reply({ protocolVersion: message.params.protocolVersion,
      capabilities: mode === "no-tools" ? {} : { tools: { listChanged: true } },
      serverInfo: { name: "local-regression-fixture", version: "1" } });
  } else if (message.method === "tools/list") {
    if (mode === "fail-list") return send({ id: message.id, error: { code: -32603, message: "fixture list failed" } });
    if (mode === "hang-list") return;
    if (mode === "names") {
      return reply({ tools: ["search.files", "search/files", "search_files", "工具查詢", `${"x".repeat(80)}a`, `${"x".repeat(80)}b`].map(tool) });
    }
    if (mode === "schemas") {
      return reply(message.params?.cursor === "second"
        ? { tools: [{ ...tool("last"), outputSchema }] }
        : { tools: [{ ...tool("first"), outputSchema }, { ...tool("task"), execution: { taskSupport: "required" } }], nextCursor: "second" });
    }
    if (changed) return reply({ tools: [tool("updated")] });
    reply(message.params?.cursor === "second" ? { tools: [tool("second")] } : { tools: [tool("first")], nextCursor: "second" });
  } else if (message.method === "tools/call") {
    if (message.params.arguments?.change) {
      changed = true;
      send({ method: "notifications/tools/list_changed" });
    }
    if (message.params.arguments?.hang) return;
    if (mode === "schemas" && message.params.name !== "task") {
      const structuredContent = message.params.arguments?.valid ? { count: 1 } : { count: "invalid" };
      return reply({ content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        ...(message.params.arguments?.missing ? {} : { structuredContent }) });
    }
    reply({ content: [{ type: "text", text: message.params.name }] });
  } else if (message.method === "ping") reply({});
  else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Unknown fixture method" } });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => { void handle(JSON.parse(line)); });
lines.on("close", () => { if (mode !== "stubborn") process.exit(0); });
