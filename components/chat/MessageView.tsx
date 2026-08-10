"use client";

import { memo } from "react";
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
import { CustomMessageView } from "./CustomMessageView";

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
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
  showModelLabel?: boolean;
  turnActivityMessages?: AssistantMessage[];
  suppressActivityBlocks?: boolean;
  turnStartedAt?: number;
  usageOverride?: AssistantUsage;
  showUsage?: boolean;
  showActions?: boolean;
  onQuote?: (text: string) => void;
  isBookmarked?: boolean;
  onToggleBookmark?: (entryId: string) => void;
}

// Memoized: streaming updates re-render ChatWindow on every token, and without
// memo every historical message would re-run its full markdown/highlight pass.
export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, modelNames, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, onEditRerun, showTimestamp, prevTimestamp, onOpenModels, authRecovered, showModelLabel, turnActivityMessages, suppressActivityBlocks, turnStartedAt, usageOverride, showUsage, showActions, onQuote, isBookmarked = false, onToggleBookmark }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} onEditRerun={onEditRerun} onQuote={onQuote} isBookmarked={isBookmarked} onToggleBookmark={onToggleBookmark} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} onOpenModels={onOpenModels} authRecovered={authRecovered} showModelLabel={showModelLabel} turnActivityMessages={turnActivityMessages} suppressActivityBlocks={suppressActivityBlocks} turnStartedAt={turnStartedAt} usageOverride={usageOverride} showUsage={showUsage} showActions={showActions} onQuote={onQuote} bookmarkEntryId={entryId} isBookmarked={isBookmarked} onToggleBookmark={onToggleBookmark} />;
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
