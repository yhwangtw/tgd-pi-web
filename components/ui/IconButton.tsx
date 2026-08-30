"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import styles from "./IconButton.module.css";

export type IconButtonSize = "compact" | "default" | "touch";
export type IconButtonVariant = "ghost" | "surface" | "danger";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children" | "title"> {
  label: string;
  icon: ReactNode;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  tooltip?: string;
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  label,
  icon,
  size = "default",
  variant = "ghost",
  tooltip,
  pressed,
  className,
  type = "button",
  ...props
}, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={[styles.root, className].filter(Boolean).join(" ")}
      data-size={size}
      data-variant={variant}
      aria-label={label}
      aria-pressed={pressed}
      title={tooltip ?? label}
    >
      <span className={styles.icon} aria-hidden="true">{icon}</span>
    </button>
  );
});
