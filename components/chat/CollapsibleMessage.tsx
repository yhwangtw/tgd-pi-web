"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import styles from "./CollapsibleMessage.module.css";
import { useI18n } from "@/lib/i18n";

// Collapse only messages meaningfully taller than the preview, so nothing
// ends up clipped by a couple of lines. Heights in px; LINE approximates the
// body line-height for the "~N lines" label.
const TRIGGER = 720;
const COLLAPSED = 380;
const LINE = 24;

interface Props {
  /** False for the current turn — the latest exchange never collapses. */
  collapsible: boolean;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

/**
 * Height-clamps long historical messages behind a fade + expand affordance.
 * Measured in a layout effect so the clamp applies before first paint (no
 * height jump on session load); ResizeObserver re-measures when async content
 * (highlighted code, images, Mermaid) settles.
 */
export function CollapsibleMessage({ collapsible, expanded, onToggle, children }: Props) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [fullHeight, setFullHeight] = useState(0);

  useLayoutEffect(() => {
    if (!collapsible) return;
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setFullHeight(el.scrollHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsible]);

  const { t } = useI18n();
  const overflows = collapsible && fullHeight > TRIGGER;
  const collapsed = overflows && !expanded;
  const hiddenLines = Math.max(1, Math.round((fullHeight - COLLAPSED) / LINE));

  return (
    <div>
      <div
        ref={innerRef}
        className={collapsed ? styles.clip : undefined}
        style={collapsed ? { maxHeight: COLLAPSED } : undefined}
      >
        {children}
        {collapsed && <div className={styles.fade} aria-hidden />}
      </div>
      {collapsed && (
        <button type="button" className={styles.toggleBtn} onClick={onToggle}>
          <ChevronDown size={11} strokeWidth={2.5} aria-hidden />
          {t("chat.showFull")} · ~{hiddenLines} {t("chat.lines")}
        </button>
      )}
      {overflows && expanded && (
        <button type="button" className={styles.toggleBtn} onClick={onToggle}>
          <ChevronUp size={11} strokeWidth={2.5} aria-hidden />
          {t("chat.collapseMsg")}
        </button>
      )}
    </div>
  );
}
