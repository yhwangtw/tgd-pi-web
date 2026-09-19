"use client";

import { useState } from "react";
import { DEFAULT_SUBAGENT_LIMITS } from "@/lib/agent-run-limits";
import type { AgentRunLimits } from "@/lib/agent-run-types";
import { useI18n } from "@/lib/i18n";
import s from "./AgentBudgetSettings.module.css";

export function AgentBudgetSettings({ limits, maxConcurrency, onSaved }: { limits?: AgentRunLimits; maxConcurrency: number; onSaved: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current = { ...DEFAULT_SUBAGENT_LIMITS, ...limits };
  return <details className={s.settings}>
    <summary>{t("agents.limits")}</summary>
    <p>{t("agents.limitsHint")}</p>
    <form key={JSON.stringify(current)} onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      const form = new FormData(event.currentTarget);
      setBusy(true); setMessage("");
      try {
        const response = await fetch("/api/agent-runs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxConcurrency, subagentLimits: {
          maxTurns: Number(form.get("turns")), maxCostUsd: Number(form.get("cost")), timeoutMs: Math.round(Number(form.get("minutes")) * 60_000),
        } }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
        setMessage(t("common.saved")); onSaved();
      } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); }
    }}>
      <label>{t("agents.turns")}<input required name="turns" type="number" min="0" step="1" defaultValue={current.maxTurns} /></label>
      <label>{t("agents.costLimit")}<input required name="cost" type="number" min="0" step="0.01" defaultValue={current.maxCostUsd} /></label>
      <label>{t("agents.minutes")}<input required name="minutes" type="number" min="0" max="35791" step="1" defaultValue={current.timeoutMs / 60_000} /></label>
      <button type="submit" disabled={busy}>{t(busy ? "common.loading" : "common.save")}</button>
    </form>
    {message && <p role="status">{message}</p>}
  </details>;
}
