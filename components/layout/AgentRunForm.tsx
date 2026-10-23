"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { fetchJson, useRequestResource } from "@/hooks/useRequestResource";
import { useI18n } from "@/lib/i18n";
import { THINKING_LEVEL_OPTIONS } from "@/lib/thinking-levels";
import type { AgentRun } from "@/lib/agent-run-types";
import { DialogShell } from "@/components/ui/DialogShell";
import s from "./AgentDashboardPanel.module.css";

type ToolMode = "readonly" | "coding" | "none";

const TOOL_NAMES: Record<ToolMode, string[]> = {
  readonly: ["read", "grep", "find", "ls", "ask_user"],
  coding: ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_user"],
  none: [],
};

interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

interface Props {
  defaultCwd: string | null;
  onCancel: () => void;
  onCreated: (run: AgentRun) => void;
}

export function AgentRunForm({ defaultCwd, onCancel, onCreated }: Props) {
  const { t } = useI18n();
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const catalogCwd = cwd.trim();
  const catalog = useRequestResource<{ modelList?: ModelOption[] }>(
    catalogCwd.startsWith("/") ? `run-form-models:${catalogCwd}` : null,
    signal => fetchJson("/api/models", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: catalogCwd }),
    }, signal),
    { debounceMs: 350, staleTimeMs: 60_000, retries: 0 },
  );
  const models = catalog.data?.modelList ?? [];
  const modelsLoading = catalogCwd.startsWith("/") && !catalog.data && !catalog.error;
  const projects = useRequestResource<{ repos?: { path: string; name: string }[] }>(
    "run-form-projects", signal => fetchJson("/api/projects/discover", {}, signal),
    { staleTimeMs: 60_000, retries: 0 },
  );
  const projectPaths = [...new Set([defaultCwd, ...(projects.data?.repos ?? []).map(repo => repo.path)].filter((path): path is string => Boolean(path)))];
  const [thinkingLevel, setThinkingLevel] = useState("auto");
  const [toolMode, setToolMode] = useState<ToolMode>("readonly");
  const [durable, setDurable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationAttempted, setValidationAttempted] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setValidationAttempted(true);
    if (!name.trim() || !cwd.trim() || !prompt.trim()) {
      window.requestAnimationFrame(() => {
        document.getElementById(formId)?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }
    setSaving(true);
    setError(null);
    const selected = models.find((item) => `${item.provider}\u0000${item.id}` === model);
    try {
      const response = await fetch("/api/agent-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          cwd,
          prompt,
          toolNames: TOOL_NAMES[toolMode].filter(tool => !durable || tool !== "ask_user"),
          ...(durable ? { engine: "durable" } : {}),
          ...(selected ? { provider: selected.provider, modelId: selected.id } : {}),
          ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
        }),
      });
      const body = await response.json() as { run?: AgentRun; error?: string };
      if (!response.ok || !body.run) throw new Error(body.error || `HTTP ${response.status}`);
      onCreated(body.run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const nameError = validationAttempted && !name.trim();
  const cwdError = validationAttempted && !cwd.trim();
  const promptError = validationAttempted && !prompt.trim();

  return (
    <DialogShell
      open
      title={t("agents.new")}
      description={t("agents.newDescription")}
      onClose={onCancel}
      canClose={!saving}
      hasUnsavedChanges={!!(name || prompt || cwd !== (defaultCwd ?? "") || model || thinkingLevel !== "auto" || toolMode !== "readonly" || durable)}
      mobileMode="fullscreen"
      initialFocusRef={nameRef}
      bodyClassName={s.dialogBody}
      footer={(
        <>
          <button className={s.secondaryButton} type="button" onClick={onCancel} disabled={saving}>{t("agents.cancel")}</button>
          <button className={s.primaryButton} type="submit" form={formId} disabled={saving}>
            {saving ? t("agents.starting") : t("agents.start")}
          </button>
        </>
      )}
    >
      <form id={formId} className={s.dialogForm} onSubmit={submit} noValidate data-testid="agent-run-editor">
        <section className={s.formSection} aria-labelledby={`${formId}-basic`}>
          <div className={s.formSectionHeading}>
            <strong id={`${formId}-basic`}>{t("agents.basicSettings")}</strong>
            <span>{t("agents.basicSettingsHint")}</span>
          </div>
          <label className={s.field}>
            <span>{t("agents.name")}</span>
            <input
              ref={nameRef}
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("agents.namePlaceholder")}
              aria-invalid={nameError}
            />
            {nameError && <small className={s.fieldError}>{t("common.required")}</small>}
          </label>
          <label className={s.field}>
            <span>{t("agents.project")}</span>
            <input
              required
              maxLength={4096}
              className={s.monoInput}
              value={cwd}
              list={`${formId}-projects`}
              onChange={(event) => {
                setCwd(event.target.value);
                setModel("");
              }}
              aria-invalid={cwdError}
            />
            <datalist id={`${formId}-projects`}>{projectPaths.map(path => <option key={path} value={path} />)}</datalist>
            {cwdError && <small className={s.fieldError}>{t("common.required")}</small>}
          </label>
          <label className={s.field}>
            <span>{t("agents.prompt")}</span>
            <textarea
              required
              maxLength={200_000}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t("agents.promptPlaceholder")}
              aria-invalid={promptError}
            />
            {promptError && <small className={s.fieldError}>{t("common.required")}</small>}
          </label>
        </section>
        <details className={s.advanced}>
          <summary>{t("agents.advancedSettings")}</summary>
          <div className={s.advancedBody}>
            <label className={s.field}>
              <span>{t("agents.executionMode")}</span>
              <select aria-label={t("agents.executionMode")} aria-describedby={durable ? `${formId}-durable-help` : undefined} value={durable ? "durable" : "standard"} onChange={event => setDurable(event.target.value === "durable")}>
                <option value="standard">{t("agents.standardMode")}</option>
                <option value="durable">{t("agents.durableMode")}</option>
              </select>
              {durable && <small id={`${formId}-durable-help`}>{t("agents.durableHint")}</small>}
            </label>
            <div className={s.twoColumns}>
              <label className={s.field}>
                <span>{t("agents.model")}</span>
                <select aria-label={t("agents.model")} value={model} onChange={(event) => setModel(event.target.value)} disabled={!catalogCwd.startsWith("/")} aria-busy={modelsLoading}>
                  <option value="">{t(modelsLoading ? "model.catalogLoading" : "agents.projectDefault")}</option>
                  {models.map((item) => (
                    <option key={`${item.provider}\u0000${item.id}`} value={`${item.provider}\u0000${item.id}`}>
                      {item.name || item.id}
                    </option>
                  ))}
                </select>
                {catalog.error && <small className={s.fieldError} role="status">{t("model.catalogError")} <button type="button" onClick={() => void catalog.refresh()}>{t("common.retry")}</button></small>}
              </label>
              <label className={s.field}>
                <span>{t("agents.thinking")}</span>
                <select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)}>
                  {THINKING_LEVEL_OPTIONS.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset className={s.fieldset}>
              <legend>{t("agents.tools")}</legend>
              <div className={s.segmented}>
                {(["readonly", "coding", "none"] as ToolMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={toolMode === mode ? s.segmentActive : s.segment}
                    aria-pressed={toolMode === mode}
                    onClick={() => setToolMode(mode)}
                  >
                    {mode === "readonly" ? t("agents.toolsReadOnly") : mode === "coding" ? t("agents.toolsCoding") : t("agents.toolsNone")}
                  </button>
                ))}
              </div>
              {toolMode === "coding" && <small className={s.warning}>{t("agents.codingWarning")}</small>}
            </fieldset>
          </div>
        </details>
        {error && <div className={s.formError} role="alert">{error}</div>}
      </form>
    </DialogShell>
  );
}
