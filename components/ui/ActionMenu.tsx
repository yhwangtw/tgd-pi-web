"use client";

import { useRef, type ReactElement, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import styles from "./ActionMenu.module.css";

/** Shared, portalled action menu. Geometry never inherits a clipped toolbar. */
export function ActionMenu({ open, onOpenChange, label, trigger, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  trigger: ReactElement;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tabTarget = useRef<HTMLElement | null>(null);
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Menu.Trigger asChild ref={triggerRef}>{trigger}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className={styles.content}
          aria-label={label}
          align="end"
          sideOffset={6}
          collisionPadding={12}
          loop
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            event.preventDefault();
            event.stopPropagation();
            const items = Array.from(document.querySelectorAll<HTMLElement>(
              'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]',
            )).filter((node) => node.tabIndex >= 0 && !event.currentTarget.contains(node)
              && node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible"
              && !node.closest('[inert],[aria-hidden="true"]'));
            const index = items.indexOf(triggerRef.current!);
            tabTarget.current = items[index + (event.shiftKey ? -1 : 1)] ?? triggerRef.current;
            onOpenChange(false);
          }}
          onCloseAutoFocus={(event) => {
            if (tabTarget.current) {
              event.preventDefault();
              tabTarget.current.focus({ preventScroll: true });
              tabTarget.current = null;
            }
          }}
        >{children}</Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function ActionMenuItem({ children }: { children: ReactElement }) {
  return <Menu.Item className={styles.item} asChild>{children}</Menu.Item>;
}
