"use client";

import {
  displayExtensionSupport,
  type ExtensionSupportDisplay,
  type ExtensionsReport,
} from "@/lib/extensions-info";
import { useI18n, type MsgKey } from "@/lib/i18n";
import styles from "./ExtensionsConfig.module.css";

const tail = (path?: string) => (path ? path.split("/").slice(-2).join("/") : "");

const SUPPORT_LABELS: Record<ExtensionSupportDisplay, MsgKey> = {
  supported: "extensions.supported",
  partial: "extensions.partial",
  unsupported: "extensions.unsupported",
  notApplicable: "extensions.notApplicable",
};

function SupportBadge({ value }: { value: ExtensionSupportDisplay }) {
  const { t } = useI18n();
  return <span className={styles.supportBadge} data-support={value}>{t(SUPPORT_LABELS[value])}</span>;
}

export function ExtensionInventoryDetails({ report, onRunShortcut, shortcutBusy }: { report: ExtensionsReport; onRunShortcut?: (shortcut: string) => void; shortcutBusy?: string | null }) {
  const { t } = useI18n();
  const compatibility: Array<[MsgKey, ExtensionSupportDisplay]> = [
    ["extensions.providers", report.compatibility.providers],
    ["extensions.commands", report.compatibility.commands],
    ["extensions.tools", report.compatibility.tools],
    ["extensions.flags", report.compatibility.flags],
    ["extensions.commandContext", report.compatibility.commandContext],
    ["extensions.events", report.compatibility.events],
    ["extensions.resources", report.compatibility.resources],
    ["extensions.shortcuts", displayExtensionSupport(report.compatibility.shortcuts, report.shortcuts.length)],
    ["extensions.renderers", displayExtensionSupport(report.compatibility.renderers, report.renderers.length)],
    ["extensions.tuiUi", report.compatibility.tuiUi],
  ];

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("extensions.compatibility")}</div>
        <div className={styles.supportGrid}>
          {compatibility.map(([key, support]) => (
            <div key={key} className={styles.supportItem}>
              <span>{t(key)}</span>
              <SupportBadge value={support} />
            </div>
          ))}
        </div>
        <p className={styles.supportNote}>{t("extensions.interactiveUiNote")}</p>
      </div>

      {report.providers.length > 0 && <div className={styles.section}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t("extensions.providers")} ({report.providers.length})</span>
          <SupportBadge value={report.compatibility.providers} />
        </div>
        {report.providers.map((provider) => (
          <div key={provider.name} className={styles.row}>
            <span className={styles.rowName}>{provider.displayName}</span>
            <span className={styles.rowDesc} title={provider.error ?? provider.modelIds.join(", ")}>
              {provider.error ?? `${provider.availableModelCount}/${provider.modelCount} ${t("extensions.modelsAvailable")}`}
            </span>
            <span className={provider.status === "error" ? styles.statusError : styles.statusOk}>
              {provider.status}
            </span>
            {provider.sources.length > 0 && (
              <span className={styles.rowSource} title={provider.sources.join("\n")}>{tail(provider.sources[0])}</span>
            )}
          </div>
        ))}
      </div>}

      {report.shortcuts.length > 0 && <div className={styles.section}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t("extensions.shortcuts")} ({report.shortcuts.length})</span>
          <SupportBadge value={displayExtensionSupport(report.compatibility.shortcuts, report.shortcuts.length)} />
        </div>
        {report.shortcuts.map((shortcut, index) => (
          <div key={`${shortcut.shortcut}:${shortcut.source ?? index}`} className={styles.row}>
            <span className={styles.rowName}>{shortcut.shortcut}</span>
            {shortcut.description && <span className={styles.rowDesc}>{shortcut.description}</span>}
            {shortcut.source && <span className={styles.rowSource} title={shortcut.source}>{tail(shortcut.source)}</span>}
            {onRunShortcut && <button type="button" className={styles.inlineAction} disabled={shortcutBusy === shortcut.shortcut} onClick={() => onRunShortcut(shortcut.shortcut)}>{t("extensions.runShortcut")}</button>}
          </div>
        ))}
      </div>}

      {report.events.length > 0 && <div className={styles.section}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t("extensions.events")} ({report.events.length})</span>
          <SupportBadge value={report.compatibility.events} />
        </div>
        {report.events.map((event, index) => (
          <div key={`${event.name}:${event.source}:${index}`} className={styles.row}>
            <span className={styles.rowName}>{event.name}</span>
            <span className={styles.rowDesc}>{event.handlerCount} {t("extensions.handlers")}</span>
            <span className={styles.rowSource} title={event.source}>{tail(event.source)}</span>
          </div>
        ))}
      </div>}

      {report.renderers.length > 0 && <div className={styles.section}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t("extensions.renderers")} ({report.renderers.length})</span>
          <SupportBadge value={displayExtensionSupport(report.compatibility.renderers, report.renderers.length)} />
        </div>
        {report.renderers.map((renderer, index) => (
          <div key={`${renderer.type}:${renderer.customType}:${index}`} className={styles.row}>
            <span className={styles.rowName}>{renderer.customType}</span>
            <span className={styles.rowDesc}>{renderer.type}</span>
            <span className={styles.rowSource} title={renderer.source}>{tail(renderer.source)}</span>
          </div>
        ))}
      </div>}

      {report.resources.length > 0 && <div className={styles.section}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>{t("extensions.resources")} ({report.resources.length})</span>
          <SupportBadge value={report.compatibility.resources} />
        </div>
        {report.resources.map((resource, index) => (
          <div key={`${resource.type}:${resource.path ?? resource.name}:${index}`} className={styles.row}>
            <span className={styles.rowName}>{resource.name}</span>
            <span className={styles.rowDesc}>{resource.type}</span>
            <span className={styles.rowSource} title={resource.path ?? resource.source}>{tail(resource.path ?? resource.source)}</span>
          </div>
        ))}
      </div>}
    </>
  );
}
