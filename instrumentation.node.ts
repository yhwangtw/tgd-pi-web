import { ensureAgentRunSupervisor } from "./lib/agent-run-supervisor";
import { ensureScheduleRunner } from "./lib/schedule-runner";

export function registerScheduleRunner(): void {
  ensureScheduleRunner();
  // Resume explicitly queued work from trusted projects when the long-lived
  // Node server starts. Opt-in Durable runs resume their official checkpoints;
  // ordinary runs become interrupted rather than replaying an entire prompt.
  ensureAgentRunSupervisor();
}
