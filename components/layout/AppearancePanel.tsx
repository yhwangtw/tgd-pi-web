"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_SKIN, SKINS, SKIN_PREVIEWS, useSkin } from "@/lib/skin";
import { useTheme, toggleOriginFromEvent } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import { DEFAULT_FONT_SIZE, FONT_SIZES, useFontSize } from "@/lib/font-size";
import { DEFAULT_FONT_FAMILY, FONT_FAMILIES, useFontFamily } from "@/lib/font-family";
import { DEFAULT_MESSAGE_LAYOUT, MESSAGE_LAYOUTS, useMessageLayout } from "@/lib/message-layout";
import { DEFAULT_DENSITY, DENSITIES, useDensity } from "@/lib/density";
import styles from "./AppearancePanel.module.css";

interface Props {
  onClose: () => void;
}

/**
 * Appearance picker popover (rail → palette icon): theme, font size, and the
 * five skins as swatch cards. Changes apply instantly for live preview; Esc
 * or clicking outside closes.
 */
export function AppearancePanel({ onClose }: Props) {
  const { skin, setSkin } = useSkin();
  const { isDark, toggleTheme } = useTheme();
  const { fontSize, setFontSize } = useFontSize();
  const { fontFamily, setFontFamily } = useFontFamily();
  const { messageLayout, setMessageLayout } = useMessageLayout();
  const { density, setDensity } = useDensity();
  const { locale, setLocale, t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);

  // Show a log-out row only when the access gate is switched on.
  const [gateEnabled, setGateEnabled] = useState(false);
  useEffect(() => {
    fetch("/api/auth/gate")
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d: { enabled?: boolean }) => setGateEnabled(!!d.enabled))
      .catch(() => {});
  }, []);
  const logout = async () => {
    try { await fetch("/api/auth/gate", { method: "DELETE" }); } catch { /* ignore */ }
    window.location.href = "/login";
  };

  const resetAppearance = () => {
    if (isDark) toggleTheme();
    setSkin(DEFAULT_SKIN);
    setFontSize(DEFAULT_FONT_SIZE);
    setFontFamily(DEFAULT_FONT_FAMILY);
    setMessageLayout(DEFAULT_MESSAGE_LAYOUT);
    setDensity(DEFAULT_DENSITY);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Defer the outside-click listener so the opening click doesn't
    // immediately close the panel.
    const id = setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(id);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} className={`glass ${styles.panel}`} role="dialog" aria-label={t("appearance.title")}>
      <div className={styles.panelHeader}>
        <div>
          <strong>{t("appearance.title")}</strong>
          <span>{t("appearance.colors")}</span>
        </div>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label={t("appearance.close")} title={t("appearance.close")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>

      <div className={styles.themeRow} role="group" aria-label={t("appearance.title")}>
        <button
          type="button"
          className={`${styles.themeBtn} ${!isDark ? styles.themeBtnActive : ""}`}
          aria-pressed={!isDark}
          onClick={(e) => { if (isDark) toggleTheme(toggleOriginFromEvent(e)); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          {t("appearance.light")}
        </button>
        <button
          type="button"
          className={`${styles.themeBtn} ${isDark ? styles.themeBtnActive : ""}`}
          aria-pressed={isDark}
          onClick={(e) => { if (!isDark) toggleTheme(toggleOriginFromEvent(e)); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          {t("appearance.dark")}
        </button>
      </div>

      <div className={styles.sectionLabel}>{t("appearance.fontSize")}</div>
      <div className={styles.fontSizeRow} role="group" aria-label={t("appearance.fontSize")}>
        {FONT_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            className={`${styles.fontSizeBtn} ${size === fontSize ? styles.fontSizeBtnActive : ""}`}
            aria-pressed={size === fontSize}
            onClick={() => setFontSize(size)}
          >
            {t(`appearance.fontSize.${size}`)}
          </button>
        ))}
      </div>

      <div className={styles.sectionLabel}>{t("appearance.fontFamily")}</div>
      <div className={styles.fontFamilyRow} role="group" aria-label={t("appearance.fontFamily")}>
        {FONT_FAMILIES.map((family) => (
          <button
            key={family}
            type="button"
            data-family={family}
            className={`${styles.fontSizeBtn} ${family === fontFamily ? styles.fontSizeBtnActive : ""}`}
            aria-pressed={family === fontFamily}
            onClick={() => setFontFamily(family)}
          >
            {t(`appearance.fontFamily.${family}`)}
          </button>
        ))}
      </div>

      <div className={styles.sectionLabel}>{t("appearance.messageLayout")}</div>
      <div className={styles.messageLayoutRow} role="group" aria-label={t("appearance.messageLayout")}>
        {MESSAGE_LAYOUTS.map((layout) => (
          <button
            key={layout}
            type="button"
            className={`${styles.fontSizeBtn} ${layout === messageLayout ? styles.fontSizeBtnActive : ""}`}
            aria-pressed={layout === messageLayout}
            onClick={() => setMessageLayout(layout)}
          >
            {t(`appearance.messageLayout.${layout}`)}
          </button>
        ))}
      </div>

      <div className={styles.sectionLabel}>{t("appearance.density")}</div>
      <div className={styles.messageLayoutRow} role="group" aria-label={t("appearance.density")}>
        {DENSITIES.map((value) => (
          <button
            key={value}
            type="button"
            className={`${styles.fontSizeBtn} ${value === density ? styles.fontSizeBtnActive : ""}`}
            aria-pressed={value === density}
            onClick={() => setDensity(value)}
          >
            {t(`appearance.density.${value}`)}
          </button>
        ))}
      </div>

      <div className={styles.sectionLabel}>{t("appearance.language")}</div>
      <div className={styles.messageLayoutRow} role="group" aria-label={t("appearance.language")}>
        <button type="button" className={`${styles.fontSizeBtn} ${locale === "zh" ? styles.fontSizeBtnActive : ""}`} aria-pressed={locale === "zh"} onClick={() => setLocale("zh")}>繁體中文</button>
        <button type="button" className={`${styles.fontSizeBtn} ${locale === "en" ? styles.fontSizeBtnActive : ""}`} aria-pressed={locale === "en"} onClick={() => setLocale("en")}>English</button>
      </div>

      <div className={styles.sectionLabel}>{t("appearance.colors")}</div>
      <div className={styles.skinList}>
        {SKINS.map((sk) => (
          <button
            key={sk}
            type="button"
            className={`${styles.skinRow} ${sk === skin ? styles.skinRowActive : ""}`}
            aria-pressed={sk === skin}
            onClick={() => setSkin(sk)}
          >
            <span className={styles.swatches} aria-hidden>
              <span style={{ background: SKIN_PREVIEWS[sk].light }} />
              <span style={{ background: SKIN_PREVIEWS[sk].accent }} />
              <span style={{ background: SKIN_PREVIEWS[sk].dark }} />
            </span>
            <span className={styles.skinLabel}>{t(`appearance.skin.${sk}`)}</span>
            {sk === skin && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={styles.check} aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
        ))}
      </div>

      <button type="button" className={styles.resetRow} onClick={resetAppearance}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
        {t("appearance.reset")}
      </button>

      {gateEnabled && (
        <button type="button" className={styles.logoutRow} onClick={logout}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          {t("appearance.logout")}
        </button>
      )}
    </div>
  );
}
