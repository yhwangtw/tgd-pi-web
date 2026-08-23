"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { showToast } from "@/hooks/useToast";
import type { McpServerConfig, McpServerStatus } from "@/lib/mcp";
import styles from "./McpCenter.module.css";

interface Props { cwd: string | null; sessionId: string | null }
type Draft = Partial<McpServerConfig> & { argsText: string; headersText: string };

function blankDraft(cwd: string | null): Draft {
  return { name: "", enabled: false, scope: cwd ? "project" : "global", projectCwd: cwd ?? undefined, transport: "stdio", timeoutMs: 15_000, argsText: "", headersText: "{}" };
}

function toDraft(server: McpServerConfig): Draft {
  return { ...server, argsText: (server.args ?? []).join("\n"), headersText: JSON.stringify(server.headers ?? {}, null, 2) };
}

export function McpCenter({ cwd, sessionId }: Props) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const statusMap = useMemo(() => new Map(statuses.map((status) => [status.id, status])), [statuses]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/mcp${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, { cache: "no-store" });
      const body = await response.json() as { servers?: McpServerConfig[]; statuses?: McpServerStatus[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setServers(body.servers ?? []);
      setStatuses(body.statuses ?? []);
    } catch (error) { showToast(error instanceof Error ? error.message : String(error), { type: "error" }); }
    finally { setLoading(false); }
  }, [cwd]);
  useEffect(() => { void load(); }, [load]);

  const mutate = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      const response = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, sessionId }) });
      const result = await response.json() as { error?: string; deferred?: boolean };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      if (result.deferred) showToast("Saved. Reload Extensions after the active run finishes.");
      else showToast("MCP configuration updated", { type: "success" });
      await load();
      return true;
    } catch (error) { showToast(error instanceof Error ? error.message : String(error), { type: "error" }); return false; }
    finally { setBusy(null); }
  };

  const save = async () => {
    if (!draft) return;
    let headers: Record<string, string> = {};
    try { headers = JSON.parse(draft.headersText || "{}") as Record<string, string>; }
    catch { showToast("Headers must be a JSON object", { type: "error" }); return; }
    const server = {
      ...draft,
      projectCwd: draft.scope === "project" ? cwd : undefined,
      args: draft.argsText.split("\n").map((value) => value.trim()).filter(Boolean),
      headers,
      argsText: undefined,
      headersText: undefined,
    };
    const trustStdio = server.transport !== "stdio" || !server.enabled || window.confirm(`Allow “${server.name}” to start the local command “${server.command}”?`);
    if (!trustStdio) return;
    if (await mutate({ action: "save", server, trustStdio }, draft.id ?? "new")) setDraft(null);
  };

  if (loading && !servers.length) return <div className={styles.state}>Discovering MCP servers…</div>;
  return (
    <div className={styles.root}>
      <div className={styles.intro}>
        <div><h2>MCP connections</h2><p>Connect remote HTTP services or trusted local stdio servers. Their tools load through Pi’s Extension system and appear in the normal tool picker.</p></div>
        <button type="button" className={styles.primary} onClick={() => setDraft(blankDraft(cwd))}>+ Add server</button>
      </div>
      {!servers.length ? <div className={styles.empty}><strong>No MCP servers yet</strong><span>Add a server, test it, then enable it for all projects or only this workspace.</span></div> : (
        <div className={styles.list}>{servers.map((server) => {
          const status: McpServerStatus = statusMap.get(server.id) ?? { id: server.id, state: server.enabled ? "connecting" : "disabled", toolCount: 0, tools: [] };
          return <article key={server.id} className={styles.card}>
            <div className={styles.cardTop}>
              <div className={styles.identity}><span className={styles.dot} data-state={status.state} /><div><strong>{server.name}</strong><small>{server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}` : server.url}</small></div></div>
              <button type="button" role="switch" aria-checked={server.enabled} className={styles.toggle} data-on={server.enabled} disabled={busy === server.id} onClick={() => {
                const trustStdio = !server.enabled && server.transport === "stdio" ? window.confirm(`Allow “${server.name}” to start the local command “${server.command}”?`) : true;
                if (trustStdio) void mutate({ action: "toggle", id: server.id, enabled: !server.enabled, trustStdio }, server.id);
              }}><span /></button>
            </div>
            <div className={styles.meta}><span>{server.scope === "global" ? "All projects" : "This project"}</span><span data-state={status.state}>{status.state}</span><span>{status.toolCount} tools</span></div>
            {status.error && <p className={styles.error}>{status.error}</p>}
            {status.tools.length > 0 && <div className={styles.tools}>{status.tools.slice(0, 8).map((tool) => <span key={tool.name} title={tool.description}>{tool.title ?? tool.name}</span>)}{status.tools.length > 8 && <span>+{status.tools.length - 8}</span>}</div>}
            <div className={styles.actions}>
              <button type="button" onClick={() => setDraft(toDraft(server))}>Edit</button>
              <button type="button" disabled={busy === `test-${server.id}`} onClick={() => void mutate({ action: "test", id: server.id }, `test-${server.id}`)}>Test connection</button>
              <button type="button" className={styles.danger} onClick={() => { if (window.confirm(`Delete “${server.name}”?`)) void mutate({ action: "delete", id: server.id }, server.id); }}>Delete</button>
            </div>
          </article>;
        })}</div>
      )}
      {draft && <div className={styles.editor}>
        <div className={styles.editorHeader}><div><strong>{draft.id ? "Edit MCP server" : "New MCP server"}</strong><small>Use ${"${ENV_VAR}"} in HTTP headers or arguments to avoid storing secrets directly.</small></div><button type="button" onClick={() => setDraft(null)}>×</button></div>
        <div className={styles.formGrid}>
          <label><span>Name</span><input value={draft.name ?? ""} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="GitHub MCP" /></label>
          <label><span>Scope</span><select value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value as "global" | "project" })}><option value="global">All projects</option><option value="project" disabled={!cwd}>This project</option></select></label>
          <label><span>Transport</span><select value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value as "stdio" | "http" })}><option value="stdio">Local command (stdio)</option><option value="http">Remote URL (Streamable HTTP)</option></select></label>
          <label><span>Timeout</span><input type="number" min="1000" max="120000" step="1000" value={draft.timeoutMs ?? 15000} onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })} /></label>
          {draft.transport === "http" ? <>
            <label className={styles.full}><span>URL</span><input value={draft.url ?? ""} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>
            <label className={styles.full}><span>Headers (JSON)</span><textarea value={draft.headersText} onChange={(event) => setDraft({ ...draft, headersText: event.target.value })} placeholder={'{"Authorization":"Bearer ${TOKEN}"}'} /></label>
          </> : <>
            <label className={styles.full}><span>Command</span><input value={draft.command ?? ""} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></label>
            <label className={styles.full}><span>Arguments (one per line)</span><textarea value={draft.argsText} onChange={(event) => setDraft({ ...draft, argsText: event.target.value })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/project'} /></label>
          </>}
          <label className={styles.enableRow}><input type="checkbox" checked={draft.enabled ?? false} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>Enable after saving</span></label>
        </div>
        <div className={styles.editorActions}><button type="button" onClick={() => setDraft(null)}>Cancel</button><button type="button" className={styles.primary} disabled={busy !== null} onClick={() => void save()}>Save server</button></div>
      </div>}
    </div>
  );
}
