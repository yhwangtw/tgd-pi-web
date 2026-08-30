"use client";

import { useEffect, useState } from "react";
import { formatDesignContext, type DesignSnapshot } from "@/lib/design-context";
import { useI18n } from "@/lib/i18n";
import s from "./DesignInspector.module.css";

interface Props {
  active: boolean;
  onClose: () => void;
  onCapture: (context: string) => void;
}

const STYLE_PROPERTIES = [
  "display", "position", "width", "height", "min-width", "min-height", "max-width", "max-height",
  "padding", "padding-block", "padding-inline", "margin", "gap",
  "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
  "font-variant-numeric", "text-transform", "text-rendering", "text-overflow", "white-space",
  "word-break", "overflow-wrap", "-webkit-line-clamp", "color",
  "background-color", "border", "border-color", "border-radius", "box-shadow", "opacity",
  "cursor", "pointer-events", "outline", "outline-offset", "overflow", "overflow-x", "overflow-y",
  "transition-property", "transition-duration", "transition-timing-function", "transform",
  "grid-template-columns", "flex-direction", "align-items", "justify-content",
];

function cssPath(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && parts.length < 5) {
    const tag = current.tagName.toLowerCase();
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) { parts.unshift(tag); break; }
    const sameTag = [...parent.children].filter((child) => child.tagName === current!.tagName);
    const index = sameTag.indexOf(current) + 1;
    parts.unshift(`${tag}${sameTag.length > 1 ? `:nth-of-type(${index})` : ""}`);
    current = parent;
  }
  return parts.join(" > ");
}

function snapshotOf(element: HTMLElement): DesignSnapshot {
  const computed = getComputedStyle(element);
  const styles = Object.fromEntries(STYLE_PROPERTIES.map((property) => [property, computed.getPropertyValue(property)]));
  const bounds = element.getBoundingClientRect();
  return {
    selector: cssPath(element),
    tagName: element.tagName,
    text: (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240),
    html: element.outerHTML.slice(0, 4_000),
    rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    styles,
    interaction: {
      role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
      label: element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "",
      disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
      pressed: element.getAttribute("aria-pressed") ?? "",
      expanded: element.getAttribute("aria-expanded") ?? "",
      selected: element.getAttribute("aria-selected") ?? "",
      tabIndex: element.tabIndex,
    },
  };
}

export function DesignInspector({ active, onClose, onCapture }: Props) {
  const { t } = useI18n();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [rect, setRect] = useState<DesignSnapshot["rect"] | null>(null);
  const [targetStyles, setTargetStyles] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (!active) {
      setTarget(null);
      setRect(null);
      setTargetStyles(null);
      return;
    }

    const updateTarget = (element: HTMLElement | null) => {
      if (!element || element === document.body || element === document.documentElement) {
        setTarget(null);
        setRect(null);
        setTargetStyles(null);
        return;
      }
      setTarget(element);
      const snapshot = snapshotOf(element);
      setRect(snapshot.rect);
      setTargetStyles(snapshot.styles);
    };

    const onPointerMove = (event: PointerEvent) => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (!(element instanceof HTMLElement) || element.closest("[data-design-inspector]")) return;
      updateTarget(element);
    };
    const onClick = (event: MouseEvent) => {
      const element = event.target;
      if (!(element instanceof HTMLElement) || element.closest("[data-design-inspector]")) return;
      event.preventDefault();
      event.stopPropagation();
      onCapture(formatDesignContext(snapshotOf(element)));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.body.dataset.designMode = "1";
    return () => {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      delete document.body.dataset.designMode;
    };
  }, [active, onCapture, onClose]);

  if (!active) return null;

  return (
    <div className={s.root} data-design-inspector aria-live="polite">
      {rect && <div className={s.highlight} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />}
      <div className={s.toolbar}>
        <span className={s.dot} aria-hidden="true" />
        <strong>{t("topbar.designMode")}</strong>
        <span className={s.hint}>{target ? t("design.clickCapture") : t("design.moveOver")}</span>
        <button type="button" onClick={onClose} aria-label={t("design.close")}>{t("design.escapeKey")}</button>
      </div>
      {target && rect && (
        <div className={s.label} style={{ left: Math.max(8, rect.x), top: Math.max(8, rect.y - 28) }}>
          {target.tagName.toLowerCase()} · {Math.round(rect.width)}×{Math.round(rect.height)} · {targetStyles?.["font-family"]?.split(",")[0] || "—"} {targetStyles?.["font-size"] || "—"}/{targetStyles?.["line-height"] || "—"} w{targetStyles?.["font-weight"] || "—"} · r {targetStyles?.["border-radius"] || "0"}
        </div>
      )}
    </div>
  );
}
