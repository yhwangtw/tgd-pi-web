import { ensureScheduleRunner } from "@/lib/schedule-runner";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ health: ensureScheduleRunner().getHealth() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(): Promise<Response> {
  return Response.json({ health: await ensureScheduleRunner().wake() }, { headers: { "Cache-Control": "no-store" } });
}
