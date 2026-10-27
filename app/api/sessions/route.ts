import { NextResponse } from "next/server";
import { getSessionReadSnapshot } from "@/lib/session-read-store";
import { listAllSessions } from "@/lib/session-reader";

export async function GET() {
  try {
    const sessions = await listAllSessions();
    // A read-receipt storage fault must not hide the conversation list.
    let readState;
    try { readState = getSessionReadSnapshot(); } catch { /* retry on the next refresh */ }
    return NextResponse.json({ sessions, readState });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
