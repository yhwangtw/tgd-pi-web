"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useI18n } from "@/lib/i18n";
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
  const [models, setModels] = useState<ModelOption[]>([]);
  const [thinkingLevel, setThinkingLevel] = useState("auto");
  const [toolMode, setToolMode] = useState<ToolMode>("readonly");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationAttempted, setValidationAttempted] = useState(false);

  useEffect(() => {
    if (!defaultCwd) return;
    const controller = new AbortController();
    fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: defaultCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ modelList?: ModelOption[] }>;
      })
      .then((data) => setModels(data.modelList ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [defaultCwd]);

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
          toolNames: TOOL_NAMES[toolMode],
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
              onChange={(event) => {
                setCwd(event.target.value);
                if (event.target.value !== defaultCwd) setModel("");
              }}
              aria-invalid={cwdError}
            />
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
            <div className={s.twoColumns}>
              <label className={s.field}>
                <span>{t("agents.model")}</span>
                <select value={model} onChange={(event) => setModel(event.target.value)} disabled={cwd !== defaultCwd}>
                  <option value="">{t("agents.projectDefault")}</option>
                  {models.map((item) => (
                    <option key={`${item.provider}\u0000${item.id}`} value={`${item.provider}\u0000${item.id}`}>
                      {item.name || item.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className={s.field}>
                <span>{t("agents.thinking")}</span>
                <select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)}>
                  {["auto", "off", "minimal", "low", "medium", "high", "xhigh"].map((level) => (
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
