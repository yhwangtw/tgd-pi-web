import { randomUUID } from "node:crypto";
import { ensureScheduleRunner } from "@/lib/schedule-runner";
import { mutateScheduleStore, readScheduleStore } from "@/lib/schedule-store";
import type { AgentSchedule } from "@/lib/schedule-types";
import { initialNextRunAt, ScheduleValidationError, validateScheduleInput } from "@/lib/schedule-validation";

export const dynamic = "force-dynamic";

function requiresJson(req: Request): Response | null {
  return req.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    ? null
    : Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
}

export async function GET(): Promise<Response> {
  const runner = ensureScheduleRunner();
  const store = readScheduleStore();
  return Response.json({ ...store, serverTime: new Date().toISOString(), health: runner.getHealth() }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const invalidType = requiresJson(req);
  if (invalidType) return invalidType;
  try {
    const input = await validateScheduleInput(await req.json());
    const now = new Date();
    const schedule: AgentSchedule = {
      ...input,
      enabled: input.enabled ?? true,
      missedRunPolicy: input.missedRunPolicy ?? "run_once",
      toolNames: input.toolNames ?? [],
      id: randomUUID(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: initialNextRunAt(input, now),
    };
    mutateScheduleStore((store) => {
      if (store.schedules.length >= 200) throw new ScheduleValidationError("Schedule limit reached");
      store.schedules.push(schedule);
    });
    ensureScheduleRunner().reschedule();
    return Response.json({ schedule }, { status: 201 });
  } catch (error) {
    const status = error instanceof ScheduleValidationError || error instanceof SyntaxError ? 400 : 500;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
