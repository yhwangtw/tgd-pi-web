"use client";
import { useEffect, useState } from "react";
import { useI18n, type MsgKey } from "@/lib/i18n";

export function formatRunDuration(seconds: number) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

/** Only this text ticks; its surrounding transcript does not render each second. */
export function ElapsedTime({ startedAt, label, testId }: { startedAt: number; label: MsgKey; testId?: string }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!Number.isFinite(startedAt)) return null;
  return <span aria-live="off" data-testid={testId}>{t(label).replace("{time}", formatRunDuration(Math.max(0, Math.floor((now - startedAt) / 1000))))}</span>;
}
