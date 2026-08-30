"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import styles from "./login.module.css";

function LoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `${t("login.failed")} (${res.status})`);
        setBusy(false);
        return;
      }
      // Only allow same-origin relative redirects (avoid open-redirect via ?next).
      const next = params.get("next");
      const dest = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      router.replace(dest);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("login.failed"));
      setBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <LockKeyhole size={18} strokeWidth={1.8} aria-hidden />
          pi-web
        </div>
        <div className={styles.subtitle}>{t("login.description")}</div>
        <form className={styles.form} onSubmit={submit}>
          <input
            className={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("login.password")}
            autoFocus
            autoComplete="current-password"
            aria-label={t("login.password")}
          />
          <div className={styles.error}>{error}</div>
          <button className={styles.button} type="submit" disabled={busy || !password}>
            {t(busy ? "login.checking" : "login.unlock")}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary under the app router.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
