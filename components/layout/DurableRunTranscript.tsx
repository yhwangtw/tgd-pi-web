"use client";

import { useEffect, useMemo } from "react";
import { DialogShell } from "@/components/ui/DialogShell";
import { MessageView } from "@/components/chat/MessageView";
import { fetchJson, useRequestResource } from "@/hooks/useRequestResource";
import { useI18n } from "@/lib/i18n";
import type { AgentRun, DurableRunTranscript as Transcript } from "@/lib/agent-run-types";
import type { ToolResultMessage } from "@/lib/types";
import s from "./AgentDashboardPanel.module.css";

export function DurableRunTranscript({ run, onClose }: { run: AgentRun; onClose: () => void }) {
  const { t } = useI18n();
  const resource = useRequestResource<Transcript>(`durable-transcript:${run.id}`, signal =>
    fetchJson(`/api/agent-runs/${encodeURIComponent(run.id)}/transcript`, { cache: "no-store" }, signal),
  { staleTimeMs: 1_000, retries: 1 });
  const refresh = resource.refresh;
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const messages = resource.data?.messages;
  const toolResults = useMemo(() => new Map((messages ?? [])
    .filter((message): message is ToolResultMessage => message.role === "toolResult")
    .map(message => [message.toolCallId, message])), [messages]);
  return <DialogShell open title={run.name} description={t("agents.durableTranscriptHint")} onClose={onClose} size="wide" mobileMode="fullscreen" bodyClassName={s.dialogBody}>
    {resource.error && <p role="alert">{resource.error}</p>}
    <button className={s.secondaryButton} type="button" onClick={() => void refresh()}>{t("agents.refreshTranscript")}</button>
    {!messages?.length && <p role="status">{t("agents.noTranscript")}</p>}
    {resource.data?.truncated && <p role="status">{t("agents.transcriptTruncated")}</p>}
    <div data-chat-cwd={run.cwd}>
      {messages?.map((message, index) => <MessageView key={index} message={message} toolResults={toolResults} showActions={false} />)}
    </div>
  </DialogShell>;
}
