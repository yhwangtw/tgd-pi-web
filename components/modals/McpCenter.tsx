"use client";

import { useMemo, useRef, useState } from "react";
import { ExternalLink, Library, Plus, RefreshCw } from "lucide-react";
import { DialogShell } from "@/components/ui/DialogShell";
import { fetchJson, useRequestResource } from "@/hooks/useRequestResource";
import { showToast } from "@/hooks/useToast";
import { useI18n } from "@/lib/i18n";
import type { McpServerConfig, McpServerStatus } from "@/lib/mcp";
import {
  createOfficialMcpSeed,
  getOfficialMcpTemplate,
  OFFICIAL_MCP_TEMPLATES,
  type OfficialMcpTemplateId,
} from "@/lib/mcp-templates";
import styles from "./McpCenter.module.css";

interface Props { cwd: string | null; sessionId: string | null }
type Draft = Partial<McpServerConfig> & { argsText: string; headersText: string };
type PendingTest = {
  token: string;
  expiresAt: number;
  server: McpServerConfig;
  review: { id: string; name: string; command?: string; args: string[]; cwd: string | null };
};
type DraftErrors = Partial<Record<"name" | "endpoint" | "headers", string>>;
type McpResource = { servers?: McpServerConfig[]; statuses?: McpServerStatus[]; error?: string };
const EMPTY_SERVERS: McpServerConfig[] = [];
const EMPTY_STATUSES: McpServerStatus[] = [];

function blankDraft(cwd: string | null): Draft {
  return { name: "", enabled: false, scope: cwd ? "project" : "global", projectCwd: cwd ?? undefined, transport: "stdio", timeoutMs: 15_000, argsText: "", headersText: "{}" };
}

function toDraft(server: McpServerConfig): Draft {
  return { ...server, argsText: (server.args ?? []).join("\n"), headersText: JSON.stringify(server.headers ?? {}, null, 2) };
}

function templateDraft(id: OfficialMcpTemplateId, cwd: string | null): Draft {
  const seed = createOfficialMcpSeed(id, cwd);
  return {
    ...seed,
    argsText: (seed.args ?? []).join("\n"),
    headersText: JSON.stringify(seed.headers ?? {}, null, 2),
  };
}

function environmentReferences(review: PendingTest["review"]): string[] {
  const names = new Set<string>();
  for (const value of [review.command, ...review.args]) {
    for (const match of value?.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/gi) ?? []) names.add(match[1].toUpperCase());
  }
  return [...names];
}

export function McpCenter({ cwd, sessionId }: Props) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<OfficialMcpTemplateId | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({});
  const [pendingTest, setPendingTest] = useState<PendingTest | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const endpointInputRef = useRef<HTMLInputElement>(null);
  const resourceUrl = `/api/mcp${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`;
  const resource = useRequestResource<McpResource>(
    `mcp:${cwd ?? "global"}`,
    (signal) => fetchJson(resourceUrl, { cache: "no-store" }, signal),
    { staleTimeMs: 15_000, retries: 1 },
  );
  const servers = resource.data?.servers ?? EMPTY_SERVERS;
  const statuses = resource.data?.statuses ?? EMPTY_STATUSES;
  const statusMap = useMemo(() => new Map(statuses.map((status) => [status.id, status])), [statuses]);
  const statusLabels = {
    disabled: t("mcp.status.disabled"),
    connecting: t("mcp.status.connecting"),
    connected: t("mcp.status.connected"),
    error: t("mcp.status.error"),
  };

  const request = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, sessionId }),
    });
    const result = await response.json() as {
      error?: string;
      deferred?: boolean;
      confirmation?: { token: string; expiresAt: number };
      review?: PendingTest["review"];
    };
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  };

  const mutate = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      const result = await request(body);
      if (result.deferred) showToast(t("mcp.savedDeferred"));
      else showToast(t("mcp.updated"), { type: "success" });
      await resource.refresh();
      return true;
    } catch (error) { showToast(error instanceof Error ? error.message : String(error), { type: "error" }); return false; }
    finally { setBusy(null); }
  };

  const prepareTest = async (server: McpServerConfig) => {
    if (busy) return;
    if (server.transport === "http") {
      if (await mutate({ action: "test", id: server.id }, `test-${server.id}`)) {
        showToast(t("mcp.testPassed"), { type: "success" });
      }
      return;
    }
    setBusy(`test-${server.id}`);
    try {
      const result = await request({ action: "test", phase: "prepare", id: server.id });
      if (!result.confirmation || !result.review) throw new Error(t("mcp.confirmMissing"));
      setPendingTest({ ...result.confirmation, server, review: result.review });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { type: "error" });
    } finally {
      setBusy(null);
    }
  };

  const executeTest = async () => {
    if (!pendingTest || busy) return;
    setBusy(`test-${pendingTest.server.id}`);
    try {
      await request({
        action: "test",
        phase: "execute",
        id: pendingTest.server.id,
        confirmationToken: pendingTest.token,
      });
      setPendingTest(null);
      showToast(t("mcp.testPassed"), { type: "success" });
      await resource.refresh();
    } catch (error) {
      setPendingTest(null);
      showToast(error instanceof Error ? error.message : String(error), { type: "error" });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    const nextErrors: DraftErrors = {};
    if (!draft.name?.trim()) nextErrors.name = t("mcp.requiredName");
    if (draft.transport === "http" && !draft.url?.trim()) nextErrors.endpoint = t("mcp.requiredUrl");
    if (draft.transport === "stdio" && !draft.command?.trim()) nextErrors.endpoint = t("mcp.requiredCommand");
    let headers: Record<string, string> = {};
    try {
      const parsed = JSON.parse(draft.headersText || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      headers = parsed as Record<string, string>;
    } catch { nextErrors.headers = t("mcp.headersInvalid"); }
    if (Object.keys(nextErrors).length) {
      setDraftErrors(nextErrors);
      requestAnimationFrame(() => (nextErrors.name ? nameInputRef.current : endpointInputRef.current)?.focus());
      return;
    }
    const server = {
      ...draft,
      projectCwd: draft.scope === "project" ? cwd : undefined,
      args: draft.argsText.split("\n").map((value) => value.trim()).filter(Boolean),
      headers,
      argsText: undefined,
      headersText: undefined,
    };
    const trustStdio = server.transport !== "stdio" || !server.enabled || window.confirm(`${t("mcp.allowStart")}\n\n${server.name}\n${server.command}`);
    if (!trustStdio) return;
    if (await mutate({ action: "save", server, trustStdio }, draft.id ?? "new")) {
      setDraft(null);
      setSelectedTemplateId(null);
      setDraftErrors({});
    }
  };

  if (resource.loading && !servers.length) return <div className={styles.state}>{t("mcp.discovering")}</div>;
  return (
    <div className={styles.root}>
      <div className={styles.intro}>
        <div><h2>{t("mcp.title")}</h2><p>{t("mcp.description")}</p></div>
        <div className={styles.introActions}>
          <button type="button" className={styles.secondary} onClick={() => void resource.refresh()} disabled={resource.refreshing}>
            <RefreshCw size={15} strokeWidth={1.8} aria-hidden />
            {t("common.refresh")}
          </button>
          <button type="button" className={styles.primary} onClick={() => setTemplatePickerOpen(true)}>
            <Plus size={16} strokeWidth={1.8} aria-hidden />
            {t("mcp.add")}
          </button>
        </div>
      </div>
      {resource.error && <div className={styles.loadError} role="alert"><span>{resource.error}</span><button type="button" onClick={() => void resource.refresh()}>{t("common.retry")}</button></div>}
      {!servers.length ? <div className={styles.empty}><strong>{t("mcp.emptyTitle")}</strong><span>{t("mcp.emptyHint")}</span></div> : (
        <div className={styles.list}>{servers.map((server) => {
          const status: McpServerStatus = statusMap.get(server.id) ?? { id: server.id, state: server.enabled ? "connecting" : "disabled", toolCount: 0, tools: [] };
          return <article key={server.id} className={styles.card}>
            <div className={styles.cardTop}>
              <div className={styles.identity}><span className={styles.dot} data-state={status.state} /><div><strong>{server.name}</strong><small>{server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}` : server.url}</small></div></div>
              <button type="button" role="switch" aria-label={server.name} aria-checked={server.enabled} className={styles.toggle} data-on={server.enabled} disabled={busy === server.id} onClick={() => {
                const trustStdio = !server.enabled && server.transport === "stdio" ? window.confirm(`${t("mcp.allowStart")}\n\n${server.name}\n${server.command}`) : true;
                if (trustStdio) void mutate({ action: "toggle", id: server.id, enabled: !server.enabled, trustStdio }, server.id);
              }}><span /></button>
            </div>
            <div className={styles.meta}><span>{server.scope === "global" ? t("mcp.scopeAll") : t("mcp.scopeProject")}</span><span data-state={status.state}>{statusLabels[status.state]}</span><span>{status.toolCount} {t("mcp.toolsCount")}</span></div>
            {status.error && <p className={styles.error}>{status.error}</p>}
            {status.tools.length > 0 && <div className={styles.tools}>{status.tools.slice(0, 8).map((tool) => <span key={tool.name} title={tool.description}>{tool.title ?? tool.name}</span>)}{status.tools.length > 8 && <span>+{status.tools.length - 8}</span>}</div>}
            <div className={styles.actions}>
              <button type="button" onClick={() => { setSelectedTemplateId(null); setDraftErrors({}); setDraft(toDraft(server)); }}>{t("mcp.edit")}</button>
              <button type="button" disabled={busy === `test-${server.id}`} onClick={() => void prepareTest(server)}>{t("mcp.test")}</button>
              <button type="button" className={styles.danger} onClick={() => { if (window.confirm(`${t("mcp.deleteConfirm")}\n\n${server.name}`)) void mutate({ action: "delete", id: server.id }, server.id); }}>{t("mcp.delete")}</button>
            </div>
          </article>;
        })}</div>
      )}

      <DialogShell
        open={templatePickerOpen}
        title={t("mcp.galleryTitle")}
        description={t("mcp.galleryDescription")}
        onClose={() => setTemplatePickerOpen(false)}
        size="wide"
        mobileMode="fullscreen"
      >
        <div className={styles.templateGrid}>
          {OFFICIAL_MCP_TEMPLATES.map((template) => <article key={template.id} className={styles.templateCard}>
            <div className={styles.templateHead}>
              <span className={styles.templateIcon}><Library size={18} strokeWidth={1.8} aria-hidden /></span>
              <div>
                <strong>{t(template.titleKey)}</strong>
                <span>{t("mcp.officialReference")}{template.recommended ? ` · ${t("mcp.recommended")}` : ""}</span>
              </div>
            </div>
            <p>{t(template.descriptionKey)}</p>
            <dl>
              <div><dt>{t("mcp.permissions")}</dt><dd>{t(template.permissionKey)}</dd></div>
              <div><dt>{t("mcp.requirement")}</dt><dd>{t(template.requirementKey)}</dd></div>
            </dl>
            <div className={styles.templateActions}>
              <a href={template.sourceUrl} target="_blank" rel="noreferrer">
                {t("mcp.viewSource")}
                <ExternalLink size={14} strokeWidth={1.8} aria-hidden />
              </a>
              <button type="button" onClick={() => {
                setSelectedTemplateId(template.id);
                setDraftErrors({});
                setDraft(templateDraft(template.id, cwd));
                setTemplatePickerOpen(false);
              }}>{t("mcp.useTemplate")}</button>
            </div>
          </article>)}
          <article className={`${styles.templateCard} ${styles.customTemplate}`}>
            <div className={styles.templateHead}>
              <span className={styles.templateIcon}><Plus size={18} strokeWidth={1.8} aria-hidden /></span>
              <div><strong>{t("mcp.customTitle")}</strong><span>{t("mcp.advanced")}</span></div>
            </div>
            <p>{t("mcp.customDescription")}</p>
            <div className={styles.templateActions}>
              <button type="button" onClick={() => {
                setSelectedTemplateId(null);
                setDraftErrors({});
                setDraft(blankDraft(cwd));
                setTemplatePickerOpen(false);
              }}>{t("mcp.configureCustom")}</button>
            </div>
          </article>
        </div>
      </DialogShell>

      <DialogShell
        open={!!pendingTest}
        title={t("mcp.testConfirmTitle")}
        description={t("mcp.testConfirmHint")}
        onClose={() => setPendingTest(null)}
        canClose={!busy}
        size="compact"
        mobileMode="sheet"
        footer={pendingTest ? <>
          <button type="button" className={styles.secondary} disabled={!!busy} onClick={() => setPendingTest(null)}>{t("common.cancel")}</button>
          <button type="button" className={styles.primary} disabled={!!busy || Date.now() >= pendingTest.expiresAt} onClick={() => void executeTest()}>{t("mcp.runTest")}</button>
        </> : undefined}
      >
        {pendingTest && <div className={styles.reviewList}>
          <div><span>{t("mcp.command")}</span><code>{[pendingTest.review.command, ...pendingTest.review.args].filter(Boolean).join(" ")}</code></div>
          <div><span>{t("mcp.scope")}</span><strong>{pendingTest.server.scope === "global" ? t("mcp.scopeAll") : t("mcp.scopeProject")}</strong></div>
          <div><span>{t("mcp.workingDirectory")}</span><code>{pendingTest.review.cwd ?? t("mcp.applicationDefault")}</code></div>
          <div><span>{t("mcp.environmentReferences")}</span><code>{environmentReferences(pendingTest.review).join(", ") || t("mcp.none")}</code></div>
        </div>}
      </DialogShell>

      <DialogShell
        open={!!draft}
        title={draft?.id ? t("mcp.editTitle") : selectedTemplateId ? t("mcp.configureTemplate") : t("mcp.newTitle")}
        description={selectedTemplateId ? t("mcp.templateEditorHint") : t("mcp.editorHint")}
        onClose={() => { setDraft(null); setSelectedTemplateId(null); setDraftErrors({}); }}
        canClose={!busy}
        size="default"
        mobileMode="fullscreen"
        initialFocusRef={nameInputRef}
        footer={draft ? <>
          <button type="button" className={styles.secondary} disabled={!!busy} onClick={() => { setDraft(null); setSelectedTemplateId(null); setDraftErrors({}); }}>{t("common.cancel")}</button>
          <button type="button" className={styles.primary} disabled={busy !== null} onClick={() => void save()}>{t("mcp.save")}</button>
        </> : undefined}
      >
        {draft && <div className={styles.formGrid}>
          {selectedTemplateId && (() => {
            const template = getOfficialMcpTemplate(selectedTemplateId);
            return <div className={`${styles.templateSummary} ${styles.full}`}>
              <div><strong>{t(template.titleKey)}</strong><span>{t(template.descriptionKey)}</span></div>
              <a href={template.sourceUrl} target="_blank" rel="noreferrer">{t("mcp.officialSource")}<ExternalLink size={13} strokeWidth={1.8} aria-hidden /></a>
              <dl>
                <div><dt>{t("mcp.permissions")}</dt><dd>{t(template.permissionKey)}</dd></div>
                <div><dt>{t("mcp.requirement")}</dt><dd>{t(template.requirementKey)}</dd></div>
              </dl>
            </div>;
          })()}
          <label>
            <span>{t("mcp.name")}</span>
            <input ref={nameInputRef} value={draft.name ?? ""} aria-invalid={!!draftErrors.name} aria-describedby={draftErrors.name ? "mcp-name-error" : undefined} onChange={(event) => { setDraftErrors((current) => ({ ...current, name: undefined })); setDraft({ ...draft, name: event.target.value }); }} placeholder={t("mcp.namePlaceholder")} />
            {draftErrors.name && <small id="mcp-name-error" className={styles.fieldError}>{draftErrors.name}</small>}
          </label>
          <label><span>{t("mcp.scope")}</span><select value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value as "global" | "project" })}><option value="global">{t("mcp.scopeAll")}</option><option value="project" disabled={!cwd}>{t("mcp.scopeProject")}</option></select></label>
          <label><span>{t("mcp.transport")}</span><select value={draft.transport} onChange={(event) => { setDraftErrors((current) => ({ ...current, endpoint: undefined })); setDraft({ ...draft, transport: event.target.value as "stdio" | "http" }); }}><option value="stdio">{t("mcp.transportStdio")}</option><option value="http">{t("mcp.transportHttp")}</option></select></label>
          <label><span>{t("mcp.timeout")}</span><input type="number" min="1000" max="120000" step="1000" value={draft.timeoutMs ?? 15000} onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })} /></label>
          {draft.transport === "http" ? <>
            <label className={styles.full}>
              <span>{t("mcp.url")}</span>
              <input ref={endpointInputRef} value={draft.url ?? ""} aria-invalid={!!draftErrors.endpoint} aria-describedby={draftErrors.endpoint ? "mcp-endpoint-error" : undefined} onChange={(event) => { setDraftErrors((current) => ({ ...current, endpoint: undefined })); setDraft({ ...draft, url: event.target.value }); }} placeholder="https://example.com/mcp" />
              {draftErrors.endpoint && <small id="mcp-endpoint-error" className={styles.fieldError}>{draftErrors.endpoint}</small>}
            </label>
            <label className={styles.full}>
              <span>{t("mcp.headers")}</span>
              <textarea value={draft.headersText} aria-invalid={!!draftErrors.headers} aria-describedby={draftErrors.headers ? "mcp-headers-error" : undefined} onChange={(event) => { setDraftErrors((current) => ({ ...current, headers: undefined })); setDraft({ ...draft, headersText: event.target.value }); }} placeholder={'{"Authorization":"Bearer ${TOKEN}"}'} />
              {draftErrors.headers && <small id="mcp-headers-error" className={styles.fieldError}>{draftErrors.headers}</small>}
            </label>
          </> : <>
            <div className={`${styles.permissionNote} ${styles.full}`}><strong>{t("mcp.localPermissionTitle")}</strong><span>{t("mcp.localPermissionBody")}</span></div>
            <label className={styles.full}>
              <span>{t("mcp.command")}</span>
              <input ref={endpointInputRef} value={draft.command ?? ""} aria-invalid={!!draftErrors.endpoint} aria-describedby={draftErrors.endpoint ? "mcp-endpoint-error" : undefined} onChange={(event) => { setDraftErrors((current) => ({ ...current, endpoint: undefined })); setDraft({ ...draft, command: event.target.value }); }} placeholder={t("mcp.commandPlaceholder")} />
              {draftErrors.endpoint && <small id="mcp-endpoint-error" className={styles.fieldError}>{draftErrors.endpoint}</small>}
            </label>
            <label className={styles.full}><span>{t("mcp.arguments")}</span><textarea value={draft.argsText} onChange={(event) => setDraft({ ...draft, argsText: event.target.value })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/project'} /></label>
          </>}
          <label className={styles.enableRow}><input type="checkbox" checked={draft.enabled ?? false} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>{t("mcp.enableAfterSave")}</span></label>
        </div>}
      </DialogShell>
    </div>
  );
}
