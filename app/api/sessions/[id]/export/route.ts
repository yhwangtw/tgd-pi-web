import { waitForSessionMigration } from "@/lib/durable-migration";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { redactSensitiveText, redactSensitiveValue } from "@/lib/redaction";
import { getDurableChat } from "@/lib/durable-chat";
import { durableEntries, isDurableSessionId, readDurableProjection } from "@/lib/durable-session-store";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getAttachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

async function getPiCliPath(): Promise<string> {
  const resolver = (import.meta as ImportMeta & {
    resolve?: (specifier: string) => string | Promise<string>;
  }).resolve;
  if (typeof resolver === "function") {
    const indexUrl = await resolver("@earendil-works/pi-coding-agent");
    return join(dirname(fileURLToPath(indexUrl)), "cli.js");
  }

  return join(
    process.cwd(),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js"
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: requestedId } = await params;
  const id = await waitForSessionMigration(requestedId);
  let tempDir: string | undefined;
  try {
    let filePath: string | null;
    if (isDurableSessionId(id)) {
      const live = getDurableChat(id);
      const projection = live?.isAlive() ? live.getProjection() : readDurableProjection(id);
      if (!projection || projection.deleted) return NextResponse.json({ error: "Session not found" }, { status: 404 });
      tempDir = mkdtempSync(join(tmpdir(), "pi-web-export-"));
      filePath = join(tempDir, `${id}.jsonl`);
      const entries = [{ type: "session", version: 3, id, cwd: projection.info.cwd, timestamp: projection.info.created },
        ...durableEntries(projection.entries, projection.info.created)];
      writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
    } else {
      filePath = await resolveSessionPath(id);
      if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const cliPath = await getPiCliPath();
    if (!existsSync(cliPath)) {
      return NextResponse.json({ error: "pi CLI not found" }, { status: 500 });
    }

    tempDir ??= mkdtempSync(join(tmpdir(), "pi-web-export-"));

    const sessionBase = basename(filePath, ".jsonl");
    const fileName = `pi-session-${sessionBase}.html`;
    const outputPath = join(tempDir, `${randomUUID()}.html`);

    try {
      await execFileAsync(process.execPath, [cliPath, "--export", filePath, outputPath], {
        cwd: process.cwd(),
        timeout: 30_000,
        env: {
          ...process.env,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
        maxBuffer: 1024 * 1024,
      });

      // Pi's standalone exporter embeds the transcript as base64 JSON. Redact
      // that payload before encoding it again; scanning the HTML alone cannot
      // see credentials inside the transcript.
      const html = redactSensitiveText(readFileSync(outputPath, "utf8").replace(
        /(<script\b[^>]*\bid="session-data"[^>]*>)([^<]*)(<\/script>)/,
        (_match, opening: string, encoded: string, closing: string) => {
          const data = JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8"));
          return `${opening}${Buffer.from(JSON.stringify(redactSensitiveValue(data))).toString("base64")}${closing}`;
        },
      ));
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": getAttachmentDisposition(fileName),
          "Cache-Control": "no-cache",
        },
      });
    } finally {
      rmSync(outputPath, { force: true });
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
