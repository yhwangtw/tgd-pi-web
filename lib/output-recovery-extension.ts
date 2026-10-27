import { createHash } from "node:crypto";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getAssistantOutputIssue, hasVisibleAssistantAnswer } from "./assistant-outcome";
import { readWorkflow, WORKFLOW_ENTRY } from "./workflow-state";

export const OUTPUT_RECOVERY_ENTRY = "pi-web-output-continuation";
export const ANSWER_RECOVERY_PROMPT = "The previous response ended without a visible answer. Use the context and work already available to answer the user's current request directly now. Prioritize a concise visible answer over more private reasoning. Preserve completed work and do not repeat completed tool actions.";

function workflow(ctx: ExtensionContext) {
  const entry = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === WORKFLOW_ENTRY);
  return { exists: !!entry, state: entry?.type === "custom" ? readWorkflow(entry.data) : null };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only the answer-recovery request changes; the user's saved level/cap stays intact. */
export function prioritizeVisibleAnswer(payload: unknown, model: ExtensionContext["model"]): unknown {
  if (!record(payload) || !model || payload.model !== model.id) return undefined;
  const level = getSupportedThinkingLevels(model).find(level => level !== "off");
  if (!level) return undefined;
  const effort = model.thinkingLevelMap?.[level] ?? level;
  if (record(payload.reasoning) && typeof payload.reasoning.effort === "string"
    && !["none", "off"].includes(payload.reasoning.effort)) {
    return { ...payload, reasoning: { ...payload.reasoning, effort } };
  }
  if (typeof payload.reasoning_effort === "string" && !["none", "off"].includes(payload.reasoning_effort)) {
    return { ...payload, reasoning_effort: effort };
  }
  if (record(payload.thinking) && payload.thinking.type === "enabled"
    && typeof payload.thinking.budget_tokens === "number" && typeof payload.max_tokens === "number"
    && payload.max_tokens >= 2048) {
    return { ...payload, thinking: { ...payload.thinking, budget_tokens: Math.min(payload.thinking.budget_tokens, 1024, payload.max_tokens - 1024) } };
  }
  // Unknown provider schemas and unsupported settings are deliberately left to Pi.
  return undefined;
}

/** Continue a capped answer through Pi's official in-loop boundary, not a new user prompt. */
export function createOutputRecoveryExtension(): InlineExtension {
  return { name: "Pi Web answer continuation", hidden: true, factory(pi) {
    let goalId: string | null = null;
    let lastEntryId: string | null = null;
    let noAnswerRecoveryUsed = false;
    let answerRequest = false;
    const seenParts = new Set<string>();
    const reset = () => {
      goalId = null; lastEntryId = null; noAnswerRecoveryUsed = false; answerRequest = false; seenParts.clear();
    };
    pi.on("before_agent_start", (_event, ctx) => {
      reset(); goalId = workflow(ctx).state?.goal?.id ?? null;
    });
    pi.on("session_start", reset);
    pi.on("input", (_event, ctx) => { reset(); goalId = workflow(ctx).state?.goal?.id ?? null; });
    pi.on("model_select", (_event, ctx) => { reset(); goalId = workflow(ctx).state?.goal?.id ?? null; });
    pi.on("session_tree", reset);
    pi.on("session_shutdown", reset);
    pi.on("before_provider_request", (event, ctx) => {
      if (!answerRequest) return undefined;
      const payload = event.payload;
      const messages = record(payload) ? payload.messages ?? payload.input : undefined;
      // Compaction is a separate request. Its prompt may quote this instruction,
      // but only an actual message in the answer context identifies recovery.
      const isAnswer = Array.isArray(messages) && messages.some(message => record(message) && message.role === "user"
        && (message.content === ANSWER_RECOVERY_PROMPT || (Array.isArray(message.content)
          && message.content.some(block => record(block) && block.text === ANSWER_RECOVERY_PROMPT))));
      return isAnswer ? prioritizeVisibleAnswer(payload, ctx.model) : undefined;
    });
    pi.on("turn_end", (event, ctx) => {
      if (event.messageEntryId !== lastEntryId) answerRequest = false;
      if (event.outcome !== "completed" || ctx.signal?.aborted || event.continue
        || event.context.pendingMessages.length || ctx.hasPendingMessages()
        || event.message.role !== "assistant" || event.messageEntryId === lastEntryId) return;
      const issue = getAssistantOutputIssue(event.message);
      if (!issue) return;
      // Below the model's intended ceiling, Pi owns context-clamped/premature
      // truncation recovery (compact and retry). Never bypass that machinery.
      if (issue === "output_limit" && (!ctx.model || !event.message.usage
        || event.message.provider !== ctx.model.provider || event.message.model !== ctx.model.id
        || isContextOverflow(event.message, ctx.model.contextWindow)
        || !(ctx.model.maxTokens > 0) || event.message.usage.output < ctx.model.maxTokens)) return;
      const current = workflow(ctx);
      if (current.exists && !current.state) return;
      const goal = current.state?.goal;
      if ((goal?.id ?? null) !== goalId || (goal && (goal.status !== "active"
        || (goal.tokenBudget && goal.tokens >= goal.tokenBudget)
        || (goal.automaticRunLimit && goal.automaticRuns >= goal.automaticRunLimit)))) return;
      const text = event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
      const visible = hasVisibleAssistantAnswer(event.message);
      if (visible) {
        const signature = createHash("sha256").update(text.replace(/\s+/g, " ") || JSON.stringify(event.message.content)).digest("hex");
        if (seenParts.has(signature)) return; // Repeated chunks are not progress.
        seenParts.add(signature);
      } else {
        if (noAnswerRecoveryUsed) return; // Do not spin on a provider returning only reasoning/empty output.
        noAnswerRecoveryUsed = true;
        answerRequest = true;
      }
      lastEntryId = event.messageEntryId;
      return {
        entries: [{ type: "custom_message", customType: OUTPUT_RECOVERY_ENTRY, display: false,
          content: visible
            ? "The previous response reached its output ceiling. Continue fulfilling the user's current request from the exact point reached. Preserve completed work and do not repeat earlier answer text or completed tool actions. Finish the remaining answer; do not ask the user to request continuation."
            : ANSWER_RECOVERY_PROMPT,
          details: { reason: issue } }],
        continue: true,
      };
    });
  } };
}
