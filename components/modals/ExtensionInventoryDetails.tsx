"use client";

import {
  displayExtensionSupport,
  type ExtensionPermissionId,
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

const PERMISSION_LABELS: Record<ExtensionPermissionId, MsgKey> = {
  filesystem: "extensions.permission.filesystem",
  process: "extensions.permission.process",
  network: "extensions.permission.network",
  credentials: "extensions.permission.credentials",
  agentTools: "extensions.permission.agentTools",
  commands: "extensions.permission.commands",
  providers: "extensions.permission.providers",
  configuration: "extensions.permission.configuration",
  lifecycle: "extensions.permission.lifecycle",
  keyboard: "extensions.permission.keyboard",
  display: "extensions.permission.display",
  instructions: "extensions.permission.instructions",
  appearance: "extensions.permission.appearance",
};

const SCOPE_LABELS = {
  runtime: "extensions.scope.runtime",
  project: "extensions.scope.project",
  user: "extensions.scope.user",
  unknown: "extensions.scope.unknown",
} satisfies Record<ExtensionsReport["permissions"][number]["scope"], MsgKey>;

const ORIGIN_LABELS = {
  inline: "extensions.origin.inline",
  package: "extensions.origin.package",
  local: "extensions.origin.local",
  unknown: "extensions.origin.unknown",
} satisfies Record<ExtensionsReport["permissions"][number]["origin"], MsgKey>;

function SupportBadge({ value }: { value: ExtensionSupportDisplay }) {
  const { t } = useI18n();
  return <span className={styles.supportBadge} data-support={value}>{t(SUPPORT_LABELS[value])}</span>;
}

export function ExtensionInventoryDetails({ report, onRunShortcut, shortcutBusy }: { report: ExtensionsReport; onRunShortcut?: (shortcut: string) => void; shortcutBusy?: string | null }) {
  const { t } = useI18n();
  const compatibility: Array<{ key: MsgKey; support: ExtensionsReport["compatibility"][keyof ExtensionsReport["compatibility"]]; display: ExtensionSupportDisplay }> = [
    { key: "extensions.providers", support: report.compatibility.providers, display: report.compatibility.providers },
    { key: "extensions.commands", support: report.compatibility.commands, display: report.compatibility.commands },
    { key: "extensions.tools", support: report.compatibility.tools, display: report.compatibility.tools },
    { key: "extensions.flags", support: report.compatibility.flags, display: report.compatibility.flags },
    { key: "extensions.commandContext", support: report.compatibility.commandContext, display: report.compatibility.commandContext },
    { key: "extensions.events", support: report.compatibility.events, display: report.compatibility.events },
    { key: "extensions.resources", support: report.compatibility.resources, display: report.compatibility.resources },
    { key: "extensions.shortcuts", support: report.compatibility.shortcuts, display: displayExtensionSupport(report.compatibility.shortcuts, report.shortcuts.length) },
    { key: "extensions.renderers", support: report.compatibility.renderers, display: displayExtensionSupport(report.compatibility.renderers, report.renderers.length) },
    { key: "extensions.tuiUi", support: report.compatibility.tuiUi, display: report.compatibility.tuiUi },
  ];
  const supportGroups = [
    { support: "supported" as const, title: "extensions.group.supported" as MsgKey, description: "extensions.group.supportedHint" as MsgKey },
    { support: "partial" as const, title: "extensions.group.partial" as MsgKey, description: "extensions.group.partialHint" as MsgKey },
    { support: "unsupported" as const, title: "extensions.group.unsupported" as MsgKey, description: "extensions.group.unsupportedHint" as MsgKey },
  ];

  return (
    <>
      {report.permissions.length > 0 && <div className={styles.section} data-testid="extension-permissions">
        <div className={styles.sectionTitle}>{t("extensions.permissions")}</div>
        <p className={styles.permissionIntro}>{t("extensions.permissionsNote")}</p>
        <div className={styles.permissionList}>
          {report.permissions.map((manifest) => {
            const observed = manifest.capabilities.filter((capability) => capability.evidence === "observed");
            const potential = manifest.capabilities.filter((capability) => capability.evidence === "potential");
            return (
              <article key={manifest.source} className={styles.permissionCard}>
                <header className={styles.permissionHeader}>
                  <code title={manifest.source}>{tail(manifest.source) || manifest.source}</code>
                  <div className={styles.permissionMeta}>
                    <span>{t(SCOPE_LABELS[manifest.scope])}</span>
                    <span>{t(ORIGIN_LABELS[manifest.origin])}</span>
                  </div>
                </header>
                {observed.length > 0 && (
                  <div className={styles.permissionGroup}>
                    <span className={styles.permissionGroupLabel}>{t("extensions.observedAccess")}</span>
                    <div className={styles.permissionChips}>
                      {observed.map((capability) => (
                        <span key={`${capability.evidence}:${capability.id}`} className={styles.permissionChip} data-evidence="observed">
                          {t(PERMISSION_LABELS[capability.id])}{capability.count > 1 ? ` ×${capability.count}` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <div className={styles.permissionGroup}>
                  <span className={styles.permissionGroupLabel}>{t("extensions.potentialAccess")}</span>
                  <div className={styles.permissionChips}>
                    {potential.map((capability) => (
                      <span key={`${capability.evidence}:${capability.id}`} className={styles.permissionChip} data-evidence="potential">
                        {t(PERMISSION_LABELS[capability.id])}
                      </span>
                    ))}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("extensions.compatibility")}</div>
        <div className={styles.supportGroups}>
          {supportGroups.map((group) => {
            const items = compatibility.filter((item) => item.support === group.support);
            return <section key={group.support} className={styles.supportGroup} data-support={group.support}>
              <header className={styles.supportGroupHeader}>
                <strong>{t(group.title)}</strong>
                <span>{t(group.description)}</span>
              </header>
              {items.length > 0 ? <div className={styles.supportGrid}>
                {items.map((item) => (
                  <div key={item.key} className={styles.supportItem}>
                    <span>{t(item.key)}</span>
                    <SupportBadge value={item.display} />
                  </div>
                ))}
              </div> : <div className={styles.supportEmpty}>{t("extensions.group.empty")}</div>}
            </section>;
          })}
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
