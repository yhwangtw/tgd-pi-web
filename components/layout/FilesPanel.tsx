"use client";

import { Folder } from "lucide-react";
import { FileExplorer } from "../sidebar/FileExplorer";
import { useI18n } from "@/lib/i18n";
import s from "./FilesPanel.module.css";

interface Props {
  cwd: string | null;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string) => void;
  refreshKey?: number;
  onOpenDiff?: (relativePath: string) => void;
  activeFilePath?: string | null;
  revealSignal?: number;
}

/**
 * Full-height file tree panel — the Files view of the contextual panel.
 * Splitting this out of SessionSidebar gives both the session list and the
 * tree the whole column instead of fighting over one.
 */
export function FilesPanel({ cwd, onOpenFile, onAtMention, refreshKey, onOpenDiff, activeFilePath, revealSignal }: Props) {
  const { t } = useI18n();

  if (!cwd) {
    return (
      <div className={s.empty}>
        <Folder size={24} strokeWidth={1.5} aria-hidden />
        <span>{t("sidebar.selectProjectFirst")}</span>
      </div>
    );
  }

  const shortCwd = cwd.length > 34 ? `…${cwd.slice(-33)}` : cwd;

  return (
    <div className={s.container}>
      <div className={`${s.header} chrome-mono`} title={cwd}>
        {shortCwd}
      </div>
      <div className={s.tree}>
        <FileExplorer cwd={cwd} onOpenFile={onOpenFile} refreshKey={refreshKey} onAtMention={onAtMention} onOpenDiff={onOpenDiff} activeFilePath={activeFilePath} revealSignal={revealSignal} />
      </div>
    </div>
  );
}
