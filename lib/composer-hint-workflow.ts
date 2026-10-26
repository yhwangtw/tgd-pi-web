import { readWorkflow, WORKFLOW_ENTRY } from "./workflow-state";
import { summarizeHintWorkflow, type HintWorkflow } from "./composer-hint-context";

/** Read an already-running engine only. Hint requests must never start/resume a session. */
export async function readComposerHintWorkflow(sessionId: string): Promise<HintWorkflow | null> {
  try {
    const { getRpcSession } = await import("./rpc-manager");
    const chat = getRpcSession(sessionId);
    if (!chat?.isAlive()) return null;
    const branch = chat.inner.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === WORKFLOW_ENTRY) {
        const workflow = readWorkflow(entry.data);
        if (workflow) return summarizeHintWorkflow(workflow);
      }
    }
    return {};
  } catch { return null; }
}
