import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { readFileSync, existsSync } from "fs";
import { redactSensitiveText, redactSensitiveValue } from "@/lib/redaction";

export const dynamic = "force-dynamic";

interface MessageEntry {
  type: string;
  id: string;
  timestamp: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
}

interface SessionLine extends MessageEntry {
  id: string;
  cwd?: string;
  parentSession?: string;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        const o = b as { type: string; text?: string };
        if (o.type === "text") return o.text ?? "";
        if (o.type === "thinking") return `*[thinking]*\n${o.text ?? ""}`;
        if (o.type === "toolCall") {
          const tc = o as { name?: string; toolName?: string; input?: unknown };
          return `*[tool call: ${tc.name ?? tc.toolName ?? "?"}]*\n\`\`\`json\n${JSON.stringify(redactSensitiveValue(tc.input ?? {}), null, 2)}\n\`\`\``;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath || !existsSync(filePath)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const content = readFileSync(filePath, "utf8");

    let header: { id: string; cwd: string; timestamp: string; parentSession?: string } | null = null;
    const messages: MessageEntry[] = [];
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionLine;
        if (entry.type === "session" && !header) {
          header = { id: entry.id ?? id, cwd: entry.cwd ?? "", timestamp: entry.timestamp ?? new Date().toISOString(), parentSession: entry.parentSession };
        } else if (entry.type === "message" && entry.message) {
          messages.push(entry);
        }
      } catch {
        // skip malformed lines
      }
    }

    if (!header) {
      return NextResponse.json({ error: "Invalid session file" }, { status: 500 });
    }

    // Build markdown
    const out: string[] = [];
    out.push(`# Pi Session Export`);
    out.push("");
    out.push(`- **Session ID**: \`${header.id}\``);
    out.push(`- **CWD**: \`${header.cwd}\``);
    out.push(`- **Created**: ${formatTimestamp(header.timestamp)}`);
    if (header.parentSession) {
      out.push(`- **Forked from**: \`${header.parentSession}\``);
    }
    out.push(`- **Messages**: ${messages.length}`);
    out.push("");
    out.push("---");
    out.push("");

    for (const m of messages) {
      const role = m.message!.role;
      const text = extractText(m.message!.content);
      if (!text.trim()) continue;

      const label =
        role === "user" ? "## 👤 User" :
        role === "assistant" ? "## 🤖 Assistant" :
        role === "toolResult" ? "### 🔧 Tool Result" :
        `## ${role}`;

      out.push(label);
      out.push("");
      out.push(`*${formatTimestamp(m.timestamp)}*`);
      out.push("");
      out.push(redactSensitiveText(text));
      out.push("");
      out.push("---");
      out.push("");
    }

    const md = out.join("\n");
    const fileName = `pi-session-${id.slice(0, 8)}.md`;

    return new Response(md, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
