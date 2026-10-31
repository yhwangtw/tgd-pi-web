"use client";

import { useState } from "react";
import { ArrowLeft, Maximize2, Minimize2, PanelsTopLeft, RotateCcw } from "lucide-react";
import { ActionMenu, ActionMenuItem } from "@/components/ui/ActionMenu";
import { useI18n } from "@/lib/i18n";
import { UI_ICON_SIZE } from "@/lib/ui-icons";
import styles from "./FilePanelLayoutMenu.module.css";

interface Props {
  className: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  onResetWidth: () => void;
  returnAction?: { label: string; onReturn: () => void };
}

export function FilePanelLayoutMenu({ className, expanded, onToggleExpanded, onResetWidth, returnAction }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <ActionMenu open={open} onOpenChange={setOpen} label={t("files.panelLayout")} trigger={
      <button type="button" className={className} aria-label={t("files.panelLayout")} title={t("files.panelLayout")}>
        <PanelsTopLeft size={UI_ICON_SIZE.compact} aria-hidden />
      </button>
    }>
      {returnAction && <ActionMenuItem>
        <button type="button" onClick={() => {
          setOpen(false);
          // Restore menu focus before a compact origin action hides the pane.
          requestAnimationFrame(returnAction.onReturn);
        }}>
          <ArrowLeft size={UI_ICON_SIZE.compact} aria-hidden />
          {returnAction.label}
        </button>
      </ActionMenuItem>}
      <ActionMenuItem>
        <button type="button" className={styles.desktopAction} onClick={onToggleExpanded}>
          {expanded ? <Minimize2 size={UI_ICON_SIZE.compact} aria-hidden /> : <Maximize2 size={UI_ICON_SIZE.compact} aria-hidden />}
          {t(expanded ? "topbar.restoreFilePanel" : "topbar.expandFilePanel")}
        </button>
      </ActionMenuItem>
      <ActionMenuItem>
        <button type="button" onClick={onResetWidth}>
          <RotateCcw size={UI_ICON_SIZE.compact} aria-hidden />
          {t("topbar.resetFilePanel")}
        </button>
      </ActionMenuItem>
    </ActionMenu>
  );
}
