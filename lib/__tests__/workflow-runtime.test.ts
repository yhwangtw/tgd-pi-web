import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowExtension } from "../workflow-extension";
import { createPlanModeExtension } from "../plan-mode";
import { createStructuredOutputExtension } from "../structured-output-extension";
import { WORKFLOW_ENTRY, type WorkflowState } from "../workflow-state";
import { createAskUserTool, WebExtensionUIBridge, toEnumerableExtensionUIContext } from "../web-extension-ui";
import { bindWebExtensions } from "../pi-runtime";

async function runtime() {
  initTheme("dark", false);
  const dir = process.env.PI_CODING_AGENT_DIR!;
  const faux = fauxProvider({ provider: "workflow-fixture", tokensPerSecond: Infinity });
  const models = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
  models.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [createPlanModeExtension(), createWorkflowExtension(), createStructuredOutputExtension()],
  });
  await loader.reload();
  const bridge = new WebExtensionUIBridge();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: models, customTools: [createAskUserTool(bridge)],
    model: faux.getModel(), resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(dir),
  });
  bridge.setPiTheme(session.extensionRunner!.getUIContext().theme);
  const errors: unknown[] = [];
  await bindWebExtensions(session, error => errors.push(error), toEnumerableExtensionUIContext(bridge));
  const state = () => [...session.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && e.customType === WORKFLOW_ENTRY) as { data: WorkflowState } | undefined;
  return { session, faux, errors, bridge, state: () => state()?.data };
}

describe("Goal and Plan on the real Pi SDK (offline faux model)", () => {
  it("continues from settled once and finishes through the registered completion tool", async () => {
    const r = await runtime();
    try {
      r.faux.setResponses([
        fauxAssistantMessage("Inspected the requested scope."),
        () => fauxAssistantMessage(fauxToolCall("goal_status", { goalId: r.state()!.goal!.id, status: "complete", evidence: "Fixture verification completed successfully." })),
        fauxAssistantMessage("Verified and complete."),
      ]);
      await r.session.prompt("/goal Verify the fixture");
      await vi.waitFor(() => expect(r.state()?.goal?.status).toBe("complete"), { timeout: 5000 });
      await r.session.waitForIdle();
      expect(r.faux.state.callCount).toBe(3);
      expect(r.state()?.goal?.automaticRuns).toBe(1);
      expect(r.errors).toEqual([]);
      // A completed goal clears the composer card: snapshot() only returns
      // live widgets, so no Goal entry must remain after completion.
      expect(r.bridge.snapshot().filter((e) => e.type === "extension_ui_request"
        && ((e as { statusKey?: string }).statusKey === "Goal" || (e as { widgetKey?: string }).widgetKey === "Goal"))).toEqual([]);
    } finally { await r.session.abort(); r.session.dispose(); }
  });

  it("plans without writes and requires a user command to restore tools for execution", async () => {
    const r = await runtime();
    try {
      r.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("update_plan", { title: "Fixture plan", steps: [{ text: "Verify fixture", status: "pending" }] })),
        fauxAssistantMessage("Plan is ready for review."),
      ]);
      await r.session.prompt("/plan Verify the fixture");
      await vi.waitFor(() => expect(r.state()?.plan?.status).toBe("ready"), { timeout: 5000 });
      await r.session.waitForIdle();
      expect(r.session.getActiveToolNames()).not.toContain("write");
      expect(r.faux.state.callCount).toBe(2);
      r.faux.appendResponses([
        fauxAssistantMessage(fauxToolCall("update_plan", { title: "Fixture plan", steps: [{ text: "Verify fixture", status: "completed" }] })),
        fauxAssistantMessage("Fixture verified."),
      ]);
      await r.session.prompt("/plan execute");
      await vi.waitFor(() => expect(r.state()?.plan?.status).toBe("complete"), { timeout: 5000 });
      await r.session.waitForIdle();
      expect(r.session.getActiveToolNames()).toContain("write");
      expect(r.errors).toEqual([]);
    } finally { await r.session.abort(); r.session.dispose(); }
  });
});
