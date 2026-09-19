"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InlinePanel } from "@/components/ui/InlinePanel";
import { useI18n } from "@/lib/i18n";

export function useInlineConfirm(scope: string | null) {
  const { t } = useI18n();
  const [message, setMessage] = useState<string | null>(null);
  const resolver = useRef<((accepted: boolean) => void) | null>(null);
  const settle = useCallback((accepted: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setMessage(null);
    resolve?.(accepted);
  }, []);
  useEffect(() => {
    setMessage(null);
    return () => { resolver.current?.(false); resolver.current = null; };
  }, [scope]);
  const confirm = useCallback((text: string) => {
    resolver.current?.(false);
    setMessage(text);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);
  const confirmation = <InlinePanel open={message !== null} title={t("interaction.review")} onClose={() => settle(false)}
    testId="inline-action-confirmation" footer={<>
      <button type="button" onClick={() => settle(false)}>{t("common.cancel")}</button>
      <button type="button" onClick={() => settle(true)}>{t("interaction.confirm")}</button>
    </>}><p>{message}</p></InlinePanel>;
  return { confirm, confirmation };
}
