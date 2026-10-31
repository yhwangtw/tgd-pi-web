"use client";

import { ChevronDown, FolderOpen, Plus, Settings2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { UI_ICON_SIZE } from "@/lib/ui-icons";
import s from "./WelcomeScreen.module.css";

type Props = {
  variant: "welcome" | "project" | "loading";
  projectPath?: string | null;
  onStart?: () => void;
  onOpenModels?: () => void;
};

export function WelcomeScreen({ variant, projectPath, onStart, onOpenModels }: Props) {
  const { t } = useI18n();
  const loading = variant === "loading";
  const projectName = projectPath?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || projectPath;
  return (
    <section className={s.root} data-testid="welcome-screen" data-state={variant}>
      <div className={s.content}>
        <h1 className={s.brand}>
          <span className={s.piSymbol}>π</span>
          <span>with tGD</span>
        </h1>
        {loading ? <p className={s.description} role="status">{t("welcome.loading")}</p> : <>
          <p className={s.description}>{t(variant === "project" ? "welcome.chooseFromSidebar" : "welcome.subtitle")}</p>
          {projectPath && <details className={s.project}>
            <summary aria-label={t("welcome.projectDetails").replace("{project}", projectName ?? projectPath)}>
              <FolderOpen size={UI_ICON_SIZE.control} aria-hidden="true" />
              <code>{projectName}</code>
              <ChevronDown size={UI_ICON_SIZE.compact} className={s.projectChevron} aria-hidden="true" />
            </summary>
            <code className={s.projectPath} data-testid="welcome-project-path">{projectPath}</code>
          </details>}
          <div className={s.actions}>
            <button type="button" className={s.primary} onClick={onStart}>
              <Plus size={UI_ICON_SIZE.control} aria-hidden="true" />
              {t("welcome.startConversation")}
            </button>
            <button type="button" className={s.secondary} onClick={onOpenModels}>
              <Settings2 size={UI_ICON_SIZE.control} aria-hidden="true" />
              {t("sidebar.models")}
            </button>
          </div>
          <p className={s.hint}>{t(variant === "project" ? "welcome.readyHint" : "welcome.startHint")}</p>
        </>}
      </div>
    </section>
  );
}
