"use client";

import React, { useState, useRef, useEffect } from "react";
import styles from "./ComposerSelector.module.css";

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface ModelSelectorProps {
  modelOptions: ModelOption[];
  modelsByProvider: { provider: string; options: ModelOption[] }[];
  currentName: string | null;
  model?: { provider: string; modelId: string } | null;
  isStreaming: boolean;
  onModelChange?: (provider: string, modelId: string) => void;
  className?: string;
}

export function ModelSelector({
  modelOptions,
  modelsByProvider,
  currentName,
  model,
  isStreaming,
  onModelChange,
  className,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        panelRef.current && !panelRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!modelOptions.length || !currentName || !onModelChange) return null;

  return (
    <div ref={dropdownRef} className={`${styles.root} ${className ?? ""}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setRect({ top: r.top, left: r.left, width: r.width });
          setOpen((v) => !v);
        }}
        disabled={isStreaming}
        className={`${styles.trigger} ${open ? styles.triggerOpen : ""}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
          <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
          <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
        </svg>
        <span className={styles.triggerLabel}>{currentName}</span>
      </button>
      {open && rect && (() => {
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const bottom = viewportHeight - rect.top + 6;
        const maxH = Math.max(120, Math.min(rect.top - 8, viewportHeight * 0.6));
        return (
          <div ref={panelRef} className={`${styles.panel} ${styles.panelFixed}`} style={{ bottom, left: rect.left, width: "max-content", minWidth: rect.width, maxHeight: maxH }} role="listbox" aria-label="Model">
            {modelsByProvider.map((group, gi) => (
              <div key={group.provider}>
                {modelsByProvider.length > 1 && (
                  <div className={`${styles.providerLabel} ${gi > 0 ? styles.providerLabelBordered : ""}`}>
                    {group.provider}
                  </div>
                )}
                {group.options.map((opt) => {
                  const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                  return (
                    <button
                      key={`${opt.provider}:${opt.modelId}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => { setOpen(false); if (!isActive) onModelChange(opt.provider, opt.modelId); }}
                      className={`${styles.option} ${isActive ? styles.optionActive : ""}`}
                    >
                      {isActive
                        ? <svg className={styles.check} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                        : <span className={styles.checkSpacer} />}
                      {opt.name}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
