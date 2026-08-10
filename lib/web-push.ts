import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush, { type PushSubscription } from "web-push";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface VapidConfig { publicKey: string; privateKey: string; subject: string }
interface SubscriptionStore { version: 1; subscriptions: PushSubscription[] }
const vapidPath = () => join(getAgentDir(), "web-push-vapid.json");
const subscriptionsPath = () => join(getAgentDir(), "web-push-subscriptions.json");

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function pushEnrollmentAllowed(request: Request): boolean {
  const host = new URL(request.url).hostname.toLocaleLowerCase();
  return Boolean(process.env.PIWEB_ACCESS_PASSWORD) || host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function getVapidConfig(): VapidConfig {
  const envPublic = process.env.PIWEB_VAPID_PUBLIC_KEY;
  const envPrivate = process.env.PIWEB_VAPID_PRIVATE_KEY;
  const subject = process.env.PIWEB_VAPID_SUBJECT || "mailto:local@tgd-pi-web.invalid";
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate, subject };
  const path = vapidPath();
  if (existsSync(path)) {
    try {
      const stored = JSON.parse(readFileSync(path, "utf8")) as VapidConfig;
      if (stored.publicKey && stored.privateKey) return stored;
    } catch { /* regenerate corrupt local state */ }
  }
  const config = { ...webpush.generateVAPIDKeys(), subject };
  atomicWrite(path, config);
  return config;
}

function readSubscriptions(): SubscriptionStore {
  try {
    const parsed = JSON.parse(readFileSync(subscriptionsPath(), "utf8")) as SubscriptionStore;
    return { version: 1, subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [] };
  } catch { return { version: 1, subscriptions: [] }; }
}

export function savePushSubscription(subscription: PushSubscription): number {
  const store = readSubscriptions();
  store.subscriptions = [subscription, ...store.subscriptions.filter((item) => item.endpoint !== subscription.endpoint)].slice(0, 30);
  atomicWrite(subscriptionsPath(), store);
  return store.subscriptions.length;
}

export function removePushSubscription(endpoint: string): number {
  const store = readSubscriptions();
  store.subscriptions = store.subscriptions.filter((item) => item.endpoint !== endpoint);
  atomicWrite(subscriptionsPath(), store);
  return store.subscriptions.length;
}

export function pushSubscriptionCount(): number { return readSubscriptions().subscriptions.length; }

/** Pushes only a generic state signal; prompts, errors, paths, and repo names never leave the server. */
export async function sendWebPush(url = "/?panel=attention"): Promise<void> {
  const config = getVapidConfig();
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  const store = readSubscriptions();
  const stale = new Set<string>();
  const payload = JSON.stringify({ title: "tGD Pi Web", body: "An agent needs your attention", url, tag: "pi-attention" });
  await Promise.allSettled(store.subscriptions.map(async (subscription) => {
    try { await webpush.sendNotification(subscription, payload, { TTL: 86_400, urgency: "normal" }); }
    catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) stale.add(subscription.endpoint);
      else console.error("Web push delivery failed", status ?? error);
    }
  }));
  if (stale.size > 0) {
    store.subscriptions = store.subscriptions.filter((item) => !stale.has(item.endpoint));
    atomicWrite(subscriptionsPath(), store);
  }
}
