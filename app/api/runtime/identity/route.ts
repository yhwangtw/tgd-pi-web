import { NextResponse } from 'next/server';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { createRuntimeIdentity } from '@/lib/runtime-identity';

export const dynamic = 'force-dynamic';
declare global { var __piWebRuntimeStartedAt: string | undefined }

export async function GET() {
  // These literals are captured by next.config at compile time. Reading git or
  // package.json here would falsely identify old running code as a new build.
  return NextResponse.json(createRuntimeIdentity(process.env, {
    agentDir: getAgentDir(),
    cwd: process.cwd(),
    pid: process.pid,
    startedAt: globalThis.__piWebRuntimeStartedAt ??= new Date(Date.now() - process.uptime() * 1000).toISOString(),
  }, {
    version: process.env.NEXT_PUBLIC_APP_VERSION || 'unknown',
    sourceSha: process.env.PIWEB_BUILD_SHA || null,
    dirty: process.env.PIWEB_BUILD_DIRTY ? process.env.PIWEB_BUILD_DIRTY === 'true' : null,
    builtAt: process.env.PIWEB_BUILD_TIME || null,
  }), { headers: { 'Cache-Control': 'no-store' } });
}
