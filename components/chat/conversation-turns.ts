import type { AgentMessage, AssistantMessage } from "@/lib/types";
import { getAssistantOutputIssue } from "@/lib/assistant-outcome";
import { addUsage, emptyUsage, type AssistantUsage } from "@/lib/usage-aggregation";

export interface ConversationTurn {
  userIndex: number | null;
  assistantIndices: number[];
  displayAssistantIndices: number[];
  activityOwnerIndex: number | null;
  activityMessages: AssistantMessage[];
  finalAssistantIndex: number | null;
  usage?: AssistantUsage;
}

export interface ConversationLayout {
  turns: ConversationTurn[];
  displayIndices: number[];
  displayIndexSet: Set<number>;
  activityByOwner: Map<number, AssistantMessage[]>;
  activityAssistantIndices: Set<number>;
  finalAssistantIndices: Set<number>;
  usageByFinalAssistant: Map<number, AssistantUsage>;
  turnIndexByMessageIndex: Map<number, number>;
}

export function assistantHasActivity(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === "thinking" || block.type === "toolCall");
}

export function assistantHasVisibleOutcome(message: AssistantMessage): boolean {
  return getAssistantOutputIssue(message) !== null
    || message.stopReason === "error"
    || message.stopReason === "aborted"
    || message.content.some((block) => block.type === "text" || block.type === "image");
}

function finalizeTurn(turn: ConversationTurn, messages: AgentMessage[]): void {
  turn.activityMessages = turn.assistantIndices
    .map((index) => messages[index] as AssistantMessage)
    .filter(assistantHasActivity);
}

/**
 * Build the display model for a transcript. A coding-agent turn may contain
 * many assistant/tool cycles; only outcome-bearing assistant messages remain
 * as transcript rows, while all thinking/tool activity is owned by one
 * expandable work log on the first displayed assistant row of that turn.
 */
export function buildConversationLayout(messages: AgentMessage[]): ConversationLayout {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | null = null;

  const finish = () => {
    if (!current) return;
    finalizeTurn(current, messages);

    current.displayAssistantIndices = current.assistantIndices.filter((index) =>
      assistantHasVisibleOutcome(messages[index] as AssistantMessage),
    );
    if (current.activityMessages.length > 0 && current.assistantIndices.length > 0) {
      const owner = current.displayAssistantIndices[0] ?? current.assistantIndices[0];
      current.activityOwnerIndex = owner;
      if (!current.displayAssistantIndices.includes(owner)) {
        current.displayAssistantIndices.unshift(owner);
      }
    }
    current.finalAssistantIndex = current.displayAssistantIndices.at(-1) ?? null;

    const usage = emptyUsage();
    let hasUsage = false;
    for (const index of current.assistantIndices) {
      const message = messages[index] as AssistantMessage;
      if (!message.usage) continue;
      addUsage(usage, message.usage);
      hasUsage = true;
    }
    current.usage = hasUsage ? usage : undefined;
    turns.push(current);
    current = null;
  };

  messages.forEach((message, index) => {
    if (message.role === "user") {
      finish();
      current = {
        userIndex: index,
        assistantIndices: [],
        displayAssistantIndices: [],
        activityOwnerIndex: null,
        activityMessages: [],
        finalAssistantIndex: null,
      };
      return;
    }
    if (message.role !== "assistant") return;
    if (!current) {
      current = {
        userIndex: null,
        assistantIndices: [],
        displayAssistantIndices: [],
        activityOwnerIndex: null,
        activityMessages: [],
        finalAssistantIndex: null,
      };
    }
    current.assistantIndices.push(index);
  });
  finish();

  const displayIndices: number[] = [];
  const activityByOwner = new Map<number, AssistantMessage[]>();
  const activityAssistantIndices = new Set<number>();
  const finalAssistantIndices = new Set<number>();
  const usageByFinalAssistant = new Map<number, AssistantUsage>();
  const turnIndexByMessageIndex = new Map<number, number>();

  turns.forEach((turn, turnIndex) => {
    if (turn.userIndex !== null) {
      displayIndices.push(turn.userIndex);
      turnIndexByMessageIndex.set(turn.userIndex, turnIndex);
    }
    for (const index of turn.assistantIndices) {
      turnIndexByMessageIndex.set(index, turnIndex);
      if (turn.activityMessages.length > 0) activityAssistantIndices.add(index);
    }
    for (const index of turn.displayAssistantIndices) displayIndices.push(index);
    if (turn.activityOwnerIndex !== null) {
      activityByOwner.set(turn.activityOwnerIndex, turn.activityMessages);
    }
    if (turn.finalAssistantIndex !== null) {
      finalAssistantIndices.add(turn.finalAssistantIndex);
      if (turn.usage) usageByFinalAssistant.set(turn.finalAssistantIndex, turn.usage);
    }
  });

  displayIndices.sort((a, b) => a - b);
  return {
    turns,
    displayIndices,
    displayIndexSet: new Set(displayIndices),
    activityByOwner,
    activityAssistantIndices,
    finalAssistantIndices,
    usageByFinalAssistant,
    turnIndexByMessageIndex,
  };
}
