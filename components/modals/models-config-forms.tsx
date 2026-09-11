"use client";

import { useState, useEffect } from "react";
import { Eye, EyeOff } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { useI18n } from "@/lib/i18n";
import styles from "./models-config-forms.module.css";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      {children}
    </div>
  );
}

export function TextInput({ value, onChange, placeholder, mono, ariaLabel, ariaInvalid, describedBy }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; ariaLabel?: string; ariaInvalid?: boolean; describedBy?: string }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    aria-label={ariaLabel} aria-invalid={ariaInvalid} aria-describedby={describedBy}
    className={`${styles.input} ${mono ? styles.mono : ""}`} />;
}

export function SecretTextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete = "off",
  spellCheck = false,
  style,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  style?: React.CSSProperties;
  ariaLabel?: string;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div className={styles.secretWrap} style={style}>
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={`${styles.input} ${styles.secretInput} ${mono ? styles.mono : ""}`}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
        aria-label={ariaLabel}
      />
      <IconButton
        onClick={() => setVisible((v) => !v)}
        label={visible ? t("apiKey.hide") : t("apiKey.show")}
        icon={visible ? <EyeOff strokeWidth={1.8} /> : <Eye strokeWidth={1.8} />}
        size="compact"
        className={styles.revealButton}
      />
    </div>
  );
}

export function NumInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={styles.input} />;
}

export function Select({ value, onChange, options, required }: { value: string; onChange: (v: string) => void; options: readonly string[]; required?: boolean }) {
  const { t } = useI18n();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className={`${styles.input} ${value ? "" : styles.selectEmpty}`}>
      {!required && <option value="">{t("models.inheritNone")}</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={styles.checkLabel}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className={styles.checkInput} />
      {label}
    </label>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className={styles.sectionTitle}>{children}</div>;
}
