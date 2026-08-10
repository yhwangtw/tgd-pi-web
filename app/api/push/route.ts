import type { PushSubscription } from "web-push";
import { getVapidConfig, pushEnrollmentAllowed, pushSubscriptionCount, removePushSubscription, savePushSubscription } from "@/lib/web-push";

export const dynamic = "force-dynamic";
function denied(request: Request): Response | null { return pushEnrollmentAllowed(request) ? null : Response.json({ error: "Web Push enrollment requires localhost or the app access gate" }, { status: 403 }); }

export async function GET(request: Request): Promise<Response> {
  const blocked = denied(request); if (blocked) return blocked;
  return Response.json({ supported: true, publicKey: getVapidConfig().publicKey, subscriptions: pushSubscriptionCount() }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request): Promise<Response> {
  const blocked = denied(request); if (blocked) return blocked;
  try {
    const subscription = await request.json() as PushSubscription;
    if (!subscription.endpoint?.startsWith("https://") || !subscription.keys?.auth || !subscription.keys?.p256dh) return Response.json({ error: "Invalid push subscription" }, { status: 400 });
    return Response.json({ subscriptions: savePushSubscription(subscription) }, { status: 201 });
  } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
}
export async function DELETE(request: Request): Promise<Response> {
  const blocked = denied(request); if (blocked) return blocked;
  try {
    const { endpoint } = await request.json() as { endpoint?: string };
    if (!endpoint) return Response.json({ error: "endpoint required" }, { status: 400 });
    return Response.json({ subscriptions: removePushSubscription(endpoint) });
  } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
}
