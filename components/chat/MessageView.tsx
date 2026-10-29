"use client";

import type { ToolExecutionContext } from "@/lib/tool-execution-state";
import type { GenerationMetrics } from "@/lib/generation-metrics";
import { memo, useCallback } from "react";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  CustomMessage,
} from "@/lib/types";
import { UserMessageView } from "./UserMessageView";
import { AssistantMessageView } from "./AssistantMessageView";
import { BashBlock } from "./BashBlock";
import type { BashExecutionMessage } from "@/lib/types";
import type { AssistantUsage } from "@/lib/usage-aggregation";
import { CompactionSummary, getCompactionSummary } from "./CompactionSummary";
import { CustomMessageView } from "./CustomMessageView";

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  streamingSpeedEnabled?: boolean;
  toolExecutionContext?: ToolExecutionContext;
  turnCancelled?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  onEditRerun?: (prevAssistantEntryId: string | undefined, newText: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  onOpenModels?: () => void;
  authRecovered?: boolean;
  outputRecovered?: boolean;
  showModelLabel?: boolean;
  turnActivityMessages?: AssistantMessage[];
  suppressActivityBlocks?: boolean;
  turnStartedAt?: number;
  usageOverride?: AssistantUsage;
  generationMetrics?: GenerationMetrics;
  showUsage?: boolean;
  showActions?: boolean;
  onQuote?: (entryId: string, role: "user" | "assistant", text: string) => void;
  isBookmarked?: boolean;
  onToggleBookmark?: (entryId: string) => void;
}

// Memoized: streaming updates re-render ChatWindow on every token, and without
// memo every historical message would re-run its full markdown/highlight pass.
export const MessageView = memo(function MessageView({ message, isStreaming, streamingSpeedEnabled, toolExecutionContext, turnCancelled, toolResults, modelNames, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, onEditRerun, showTimestamp, prevTimestamp, onOpenModels, authRecovered, outputRecovered, showModelLabel, turnActivityMessages, suppressActivityBlocks, turnStartedAt, usageOverride, generationMetrics, showUsage, showActions, onQuote, isBookmarked = false, onToggleBookmark }: Props) {
  const quoteMessage = useCallback((text: string) => {
    if (entryId && (message.role === "user" || message.role === "assistant")) {
      onQuote?.(entryId, message.role, text);
    }
  }, [entryId, message.role, onQuote]);
  const onQuoteText = onQuote && entryId ? quoteMessage : undefined;
  const summary = getCompactionSummary(message);
  if (summary !== null) return <CompactionSummary summary={summary} />;
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} onEditRerun={onEditRerun} onQuote={onQuoteText} isBookmarked={isBookmarked} onToggleBookmark={onToggleBookmark} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} streamingSpeedEnabled={streamingSpeedEnabled} toolExecutionContext={toolExecutionContext} turnCancelled={turnCancelled} toolResults={toolResults} modelNames={modelNames} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} onOpenModels={onOpenModels} authRecovered={authRecovered} outputRecovered={outputRecovered} showModelLabel={showModelLabel} turnActivityMessages={turnActivityMessages} suppressActivityBlocks={suppressActivityBlocks} turnStartedAt={turnStartedAt} usageOverride={usageOverride} generationMetrics={generationMetrics} showUsage={showUsage} showActions={showActions} onQuote={onQuoteText} bookmarkEntryId={entryId} isBookmarked={isBookmarked} onToggleBookmark={onToggleBookmark} />;
  }
  if (message.role === "bashExecution") {
    const bash = message as BashExecutionMessage;
    return (
      <BashBlock
        command={bash.command}
        output={bash.output}
        exitCode={bash.exitCode}
        cancelled={bash.cancelled}
        truncated={bash.truncated}
      />
    );
  }
  if (message.role === "toolResult") {
    return null;
  }
  if (message.role === "custom") {
    return <CustomMessageView message={message as CustomMessage} />;
  }
  return null;
});
