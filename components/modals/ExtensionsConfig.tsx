"use client";

import { useState, useEffect, useCallback } from "react";
import type { ExtensionsReport, ExtensionFlagInfo } from "@/lib/extensions-info";
import { showToast } from "@/hooks/useToast";
import { useI18n } from "@/lib/i18n";
import { ExtensionInventoryDetails } from "./ExtensionInventoryDetails";
import { PackageCenter } from "./PackageCenter";
import styles from "./ExtensionsConfig.module.css";

interface Props {
  /** Session whose runner we're inspecting (extensions are per-session). */
  sessionId: string | null;
  onClose: () => void;
  onReload?: () => void;
}

const tail = (p?: string) => (p ? p.split("/").slice(-2).join("/") : "");

/**
 * Extensions management panel: what the session's pi extensions loaded and
 * registered (slash commands, tools, flags), the load diagnostics that were
 * previously invisible in the web UI, live flag toggles, and a reload button
 * that uses Pi's native lifecycle to re-discover everything from disk.
 */
export function ExtensionsConfig({ sessionId, onClose, onReload }: Props) {
  const { t } = useI18n();
  const [report, setReport] = useState<ExtensionsReport | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [reloading, setReloading] = useState(false);
  const [view, setView] = useState<"loaded" | "packages">("loaded");

  const load = useCallback(async () => {
    if (!sessionId) return;
    setState("loading");
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/extensions`);
      const d = (await res.json()) as ExtensionsReport & { error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? `HTTP ${res.status}`);
        setState("error");
        return;
      }
      setReport(d);
      setState("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setFlag = useCallback(async (flag: ExtensionFlagInfo, value: boolean | string) => {
    if (!sessionId) return;
    // Optimistic; revert on failure.
    setReport((prev) => prev && {
      ...prev,
      flags: prev.flags.map((f) => (f.name === flag.name ? { ...f, value } : f)),
    });
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/extensions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_flag", name: flag.name, value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      showToast(`Flag update failed: ${e instanceof Error ? e.message : e}`, { type: "error" });
      void load();
    }
  }, [sessionId, load]);

  const reload = useCallback(async () => {
    if (!sessionId || reloading) return;
    setReloading(true);
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/extensions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reload" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(t("extensions.reloaded"));
      onReload?.();
      await load();
    } catch (e) {
      showToast(`Reload failed: ${e instanceof Error ? e.message : e}`, { type: "error" });
    } finally {
      setReloading(false);
    }
  }, [sessionId, reloading, load, t, onReload]);

  const hasErrors = report?.diagnostics.some((d) => d.type === "error");
  const hasExtensionItems = !!report && (
    report.providers.length > 0
    || report.commands.length > 0
    || report.tools.length > 0
    || report.flags.length > 0
    || report.shortcuts.length > 0
    || report.events.length > 0
    || report.renderers.length > 0
    || report.resources.length > 0
    || report.paths.length > 0
  );

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={styles.modal}
        data-testid="extensions-config"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extensions-config-title"
      >
        <div className={styles.header}>
          <div className={styles.titleGroup}>
            <span id="extensions-config-title" className={styles.title}>{t("extensions.title")}</span>
            <div className={styles.viewTabs} role="tablist" aria-label={t("extensions.title")}>
              <button type="button" role="tab" aria-selected={view === "loaded"}
                className={view === "loaded" ? styles.viewTabActive : styles.viewTab}
                onClick={() => setView("loaded")}>{t("extensions.loaded")}</button>
              <button type="button" role="tab" aria-selected={view === "packages"}
                className={view === "packages" ? styles.viewTabActive : styles.viewTab}
                onClick={() => setView("packages")}>{t("packages.title")}</button>
            </div>
          </div>
          {sessionId && <code className={styles.sessionCode}>{sessionId.slice(0, 8)}</code>}
          <div className={styles.headerActions}>
            {view === "loaded" && <button className={styles.reloadButton} onClick={() => void reload()} disabled={reloading || !sessionId}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              {reloading ? t("extensions.reloading") : t("extensions.reload")}
            </button>}
            <button onClick={onClose} className={styles.closeButton} aria-label={t("common.close")}>×</button>
          </div>
        </div>

        <div className={styles.body}>
          {view === "packages" ? (
            <PackageCenter sessionId={sessionId} />
          ) : !sessionId ? (
            <div className={styles.stateText}>{t("extensions.noSession")}</div>
          ) : state === "loading" ? (
            <div className={styles.stateText}>Loading…</div>
          ) : state === "error" ? (
            <div className={styles.stateText}>{error}</div>
          ) : report && (
            <>
              {report.diagnostics.length > 0 && (
                <div className={`${styles.diag} ${hasErrors ? styles.diagError : ""}`}>
                  {report.diagnostics.map((d, i) => (
                    <div key={i} className={styles.diagRow}>
                      <span className={`${styles.diagBadge} ${d.type === "error" ? styles.diagBadgeError : styles.diagBadgeWarning}`}>
                        {d.type}
                      </span>
                      <span>{d.message}{d.path ? ` — ${d.path}` : ""}</span>
                    </div>
                  ))}
                </div>
              )}

              <ExtensionInventoryDetails report={report} />

              {!hasExtensionItems && <div className={styles.inventoryEmpty}>{t("extensions.none")}</div>}

              {report.commands.length > 0 && <div className={styles.section}>
                <div className={styles.sectionTitle}>{t("extensions.commands")} ({report.commands.length})</div>
                {report.commands.map((c) => (
                  <div key={c.invocationName} className={styles.row}>
                    <span className={styles.rowName}>/{c.invocationName}</span>
                    {c.description && <span className={styles.rowDesc}>{c.description}</span>}
                    {c.source && <span className={styles.rowSource} title={c.source}>{tail(c.source)}</span>}
                  </div>
                ))}
              </div>}

              {report.tools.length > 0 && <div className={styles.section}>
                <div className={styles.sectionTitle}>{t("extensions.tools")} ({report.tools.length})</div>
                {report.tools.map((tool) => (
                  <div key={tool.name} className={styles.row}>
                    <span className={styles.rowName}>{tool.name}</span>
                    {tool.description && <span className={styles.rowDesc}>{tool.description}</span>}
                    {tool.source && <span className={styles.rowSource} title={tool.source}>{tail(tool.source)}</span>}
                  </div>
                ))}
              </div>}

              {report.flags.length > 0 && <div className={styles.section}>
                <div className={styles.sectionTitle}>{t("extensions.flags")} ({report.flags.length})</div>
                {report.flags.map((f) => (
                  <div key={f.name} className={styles.row}>
                    {f.type === "boolean" ? (
                      <button
                        className={`${styles.flagToggle} ${f.value === true ? styles.flagToggleOn : ""}`}
                        onClick={() => void setFlag(f, !(f.value === true))}
                        role="switch"
                        aria-checked={f.value === true}
                        aria-label={f.name}
                      >
                        <span className={styles.flagKnob} />
                      </button>
                    ) : (
                      <input
                        className={styles.flagInput}
                        defaultValue={typeof f.value === "string" ? f.value : ""}
                        onBlur={(e) => { if (e.target.value !== f.value) void setFlag(f, e.target.value); }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        aria-label={f.name}
                      />
                    )}
                    <span className={styles.rowName}>--{f.name}</span>
                    {f.description && <span className={styles.rowDesc}>{f.description}</span>}
                    {f.source && <span className={styles.rowSource} title={f.source}>{tail(f.source)}</span>}
                  </div>
                ))}
              </div>}

              {report.paths.length > 0 && <div className={styles.section}>
                <div className={styles.sectionTitle}>{t("extensions.loadedFrom")} ({report.paths.length})</div>
                {report.paths.map((p) => (
                  <div key={p} className={styles.pathRow}>{p}</div>
                ))}
              </div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
