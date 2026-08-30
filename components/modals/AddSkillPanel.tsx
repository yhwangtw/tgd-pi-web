"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ExternalLink } from "lucide-react";
import type { SkillSearchResult } from "@/app/api/skills/search/route";
import { useI18n } from "@/lib/i18n";
import { shortenPath } from "./skills-config-types";
import styles from "./AddSkillPanel.module.css";

type PendingInstall = {
  token: string;
  expiresAt: number;
  review: {
    source: string;
    scope: "global" | "project";
    cwd: string | null;
    installPath: string;
  };
};

export function AddSkillPanel({
  cwd,
  onInstalled,
}: {
  cwd: string;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedPkgs, setInstalledPkgs] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<"global" | "project">("global");
  const [pendingInstall, setPendingInstall] = useState<PendingInstall | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const res = await fetch("/api/skills/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const d = (await res.json()) as {
        results?: SkillSearchResult[];
        error?: string;
      };
      if (d.error) {
        setSearchError(d.error);
        return;
      }
      setResults(d.results ?? []);
      if ((d.results ?? []).length === 0) setSearchError(t("skills.add.noneFound"));
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }, [t]);

  const prepareInstall = useCallback(
    async (pkg: string) => {
      setInstalling(pkg);
      setInstallError(null);
      try {
        const res = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phase: "prepare", package: pkg, scope, cwd }),
        });
        const d = (await res.json()) as {
          error?: string;
          confirmation?: { token: string; expiresAt: number };
          review?: PendingInstall["review"];
        };
        if (!res.ok || d.error) {
          setInstallError(d.error ?? `HTTP ${res.status}`);
          return;
        }
        if (!d.confirmation || !d.review) {
          setInstallError(t("skills.add.reviewUnavailable"));
          return;
        }
        setPendingInstall({ ...d.confirmation, review: d.review });
      } catch (e) {
        setInstallError(String(e));
      } finally {
        setInstalling(null);
      }
    },
    [scope, cwd, t],
  );

  const executeInstall = useCallback(async () => {
    if (!pendingInstall) return;
    const pkg = pendingInstall.review.source;
    setInstalling(pkg);
    setInstallError(null);
    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: "execute",
          package: pkg,
          scope: pendingInstall.review.scope,
          cwd: pendingInstall.review.cwd,
          confirmationToken: pendingInstall.token,
        }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setInstallError(d.error ?? `HTTP ${res.status}`);
        setPendingInstall(null);
        return;
      }
      setInstalledPkgs((prev) => new Set(prev).add(pkg));
      setPendingInstall(null);
      onInstalled();
    } catch (e) {
      setInstallError(String(e));
      setPendingInstall(null);
    } finally {
      setInstalling(null);
    }
  }, [onInstalled, pendingInstall]);

  const installPath =
    scope === "global"
      ? "~/.pi/agent/skills/"
      : `${shortenPath(cwd)}/.pi/agent/skills/`;

  const searchDisabled = searching || !query.trim();

  return (
    <div className={styles.container}>
      {/* ── Header area ── */}
      <div className={styles.headerArea}>
        <div className={styles.title}>
          {t("skills.add.title")}
        </div>

        {/* Search row */}
        <div className={styles.searchRow}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search(query);
            }}
            placeholder={t("skills.add.placeholder")}
            className={styles.searchInput}
          />
          <button
            onClick={() => search(query)}
            disabled={searchDisabled}
            className={`${styles.searchBtn} ${searchDisabled ? styles.searchBtnDisabled : styles.searchBtnEnabled}`}
          >
            {t(searching ? "skills.add.searching" : "skills.add.search")}
          </button>
        </div>

        {/* Scope + install path row */}
        <div className={styles.scopeRow}>
          <div className={styles.scopeToggle}>
            {(["global", "project"] as const).map((s) => {
              const isActive = scope === s;
              const scopeBtnClass = isActive
                ? styles.scopeBtnActive
                : s === "global"
                  ? styles.scopeBtnInactiveFirst
                  : styles.scopeBtnInactive;
              return (
                <button
                  key={s}
                  onClick={() => {
                    setScope(s);
                    setPendingInstall(null);
                  }}
                  className={`${styles.scopeBtn} ${scopeBtnClass}`}
                >
                  {t(s === "global" ? "skills.add.global" : "skills.add.project")}
                </button>
              );
            })}
          </div>
          <span className={styles.installPath}>
            → {installPath}
          </span>
        </div>

        {/* Errors */}
        {searchError && (
          <div className={styles.errorText}>{searchError}</div>
        )}
        {installError && (
          <div className={styles.errorTextBreak}>
            {installError}
          </div>
        )}
        {pendingInstall && (
          <section className={styles.confirmation} role="alert">
            <div className={styles.confirmationCopy}>
              <strong>{t("skills.add.reviewTitle")}</strong>
              <code>{pendingInstall.review.source}</code>
              <span>
                {pendingInstall.review.scope === "global"
                  ? t("skills.add.allProjects")
                  : `${t("skills.add.onlyProject")}: ${shortenPath(pendingInstall.review.cwd ?? cwd)}`}
              </span>
              <span>{t("skills.add.installTo")} {shortenPath(pendingInstall.review.installPath)}</span>
            </div>
            <div className={styles.confirmationActions}>
              <button
                type="button"
                className={styles.confirmInstallBtn}
                disabled={installing !== null || Date.now() >= pendingInstall.expiresAt}
                onClick={() => void executeInstall()}
              >
                {t("skills.add.confirm")}
              </button>
              <button type="button" disabled={installing !== null} onClick={() => setPendingInstall(null)}>{t("common.cancel")}</button>
            </div>
          </section>
        )}
      </div>

      {/* ── Results list ── */}
      {results.length > 0 ? (
        <div className={styles.resultsList}>
          {results.map((r) => {
            const isInstalled = installedPkgs.has(r.package);
            const isInstalling = installing === r.package;
            const isPending = pendingInstall?.review.source === r.package;
            // split "owner/repo@skill" for cleaner display
            const atIdx = r.package.indexOf("@");
            const repopart = atIdx > -1 ? r.package.slice(0, atIdx) : r.package;
            const skillpart = atIdx > -1 ? r.package.slice(atIdx + 1) : null;

            let installBtnClass = styles.installBtn;
            if (isInstalled) {
              installBtnClass += ` ${styles.installBtnInstalled}`;
            } else if (isInstalling) {
              installBtnClass += ` ${styles.installBtnInstalling}`;
            } else if (installing !== null || pendingInstall !== null) {
              installBtnClass += ` ${styles.installBtnDisabled}`;
            } else {
              installBtnClass += ` ${styles.installBtnDefault}`;
            }

            return (
              <div
                key={r.package}
                className={styles.resultItem}
              >
                <div className={styles.resultInfo}>
                  {/* skill name prominent */}
                  <div className={styles.skillName}>
                    {skillpart ?? repopart}
                  </div>
                  {/* repo + installs + link row */}
                  <div className={styles.metaRow}>
                    <span className={styles.repoText}>
                      {repopart}
                    </span>
                    <span className={styles.installsText}>
                      {r.installs}
                    </span>
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className={styles.skillsLink}
                      >
                        {t("skills.add.directoryName")} <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                </div>
                <button
                  onClick={() =>
                    !isInstalled && !isInstalling && !pendingInstall && prepareInstall(r.package)
                  }
                  disabled={isInstalled || isInstalling || installing !== null || pendingInstall !== null}
                  className={installBtnClass}
                >
                  {isInstalled
                    ? `✓ ${t("skills.add.installed")}`
                    : isPending
                      ? t("skills.add.reviewing")
                    : isInstalling
                      ? t("skills.add.installing")
                      : t("skills.add.install")}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        !searchError &&
        !searching && (
          <div className={styles.emptyState}>
            {t("skills.add.searchPrefix")}{" "}
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              className={styles.emptyStateLink}
            >
              {t("skills.add.directoryName")}
            </a>{" "}
            {t("skills.add.searchSuffix")}
          </div>
        )
      )}
    </div>
  );
}
