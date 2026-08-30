"use client";

import { useEffect, useRef, useState } from "react";
import { Check, LogOut, Moon, RotateCcw, Sun, X } from "lucide-react";
import { DEFAULT_SKIN, SKINS, SKIN_PREVIEWS, useSkin } from "@/lib/skin";
import { useTheme, toggleOriginFromEvent } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import { DEFAULT_FONT_SIZE, FONT_SIZES, useFontSize } from "@/lib/font-size";
import { DEFAULT_FONT_FAMILY, FONT_FAMILIES, useFontFamily } from "@/lib/font-family";
import { DEFAULT_MESSAGE_LAYOUT, MESSAGE_LAYOUTS, useMessageLayout } from "@/lib/message-layout";
import { DEFAULT_DENSITY, DENSITIES, useDensity } from "@/lib/density";
import { DEFAULT_UI_STYLE, UI_STYLES, useUiStyle } from "@/lib/ui-style";
import styles from "./AppearancePanel.module.css";

interface Props {
  onClose: () => void;
}

/**
 * Appearance picker popover (rail → palette icon): interface geometry, color
 * palette, theme, and readability preferences. Changes apply instantly for
 * live preview; Esc or clicking outside closes.
 */
export function AppearancePanel({ onClose }: Props) {
  const { skin, setSkin } = useSkin();
  const { isDark, toggleTheme } = useTheme();
  const { fontSize, setFontSize } = useFontSize();
  const { fontFamily, setFontFamily } = useFontFamily();
  const { messageLayout, setMessageLayout } = useMessageLayout();
  const { density, setDensity } = useDensity();
  const { uiStyle, setUiStyle } = useUiStyle();
  const { locale, setLocale, t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

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
    setUiStyle(DEFAULT_UI_STYLE);
  };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => closeRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <>
    <div className={styles.backdrop} aria-hidden onMouseDown={onClose} />
    <div ref={ref} className={`glass ${styles.panel}`} role="dialog" aria-modal="true" aria-label={t("appearance.title")}>
      <div className={styles.panelHeader}>
        <div>
          <strong>{t("appearance.title")}</strong>
          <span>{t("appearance.subtitle")}</span>
        </div>
        <button ref={closeRef} type="button" className={styles.closeButton} onClick={onClose} aria-label={t("appearance.close")} title={t("appearance.close")}>
          <X size={14} aria-hidden />
        </button>
      </div>

      <div className={styles.themeRow} role="group" aria-label={t("appearance.title")}>
        <button
          type="button"
          className={`${styles.themeBtn} ${!isDark ? styles.themeBtnActive : ""}`}
          aria-pressed={!isDark}
          onClick={(e) => { if (isDark) toggleTheme(toggleOriginFromEvent(e)); }}
        >
          <Sun size={12} aria-hidden />
          {t("appearance.light")}
        </button>
        <button
          type="button"
          className={`${styles.themeBtn} ${isDark ? styles.themeBtnActive : ""}`}
          aria-pressed={isDark}
          onClick={(e) => { if (!isDark) toggleTheme(toggleOriginFromEvent(e)); }}
        >
          <Moon size={12} aria-hidden />
          {t("appearance.dark")}
        </button>
      </div>

      <div className={styles.sectionLabel}>{t("appearance.interfaceStyle")}</div>
      <div className={styles.messageLayoutRow} role="group" aria-label={t("appearance.interfaceStyle")}>
        {UI_STYLES.map((style) => (
          <button
            key={style}
            type="button"
            className={`${styles.fontSizeBtn} ${style === uiStyle ? styles.fontSizeBtnActive : ""}`}
            aria-pressed={style === uiStyle}
            onClick={() => setUiStyle(style)}
          >
            {t(`appearance.interfaceStyle.${style}`)}
          </button>
        ))}
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
      <div className={styles.skinList} role="group" aria-label={t("appearance.colors")}>
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
              <Check size={13} strokeWidth={2.5} className={styles.check} aria-hidden />
            )}
          </button>
        ))}
      </div>

      <button type="button" className={styles.resetRow} onClick={resetAppearance}>
        <RotateCcw size={13} aria-hidden />
        {t("appearance.reset")}
      </button>

      {gateEnabled && (
        <button type="button" className={styles.logoutRow} onClick={logout}>
          <LogOut size={13} aria-hidden />
          {t("appearance.logout")}
        </button>
      )}
    </div>
    </>
  );
}
