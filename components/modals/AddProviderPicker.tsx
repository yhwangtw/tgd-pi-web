"use client";

import { useState, useRef } from "react";
import { Plus, Search, X } from "lucide-react";
import { DialogShell } from "@/components/ui/DialogShell";
import { IconButton } from "@/components/ui/IconButton";
import { useI18n } from "@/lib/i18n";
import type { OAuthProvider, ApiKeyProvider } from "./models-config-types";
import { ProviderIcon } from "./ProviderIcon";
import styles from "./AddProviderPicker.module.css";

interface AddProviderPickerProps {
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onAddCustom: () => void;
  onClose: () => void;
}

export function AddProviderPicker({
  oauthProviders, apiKeyProviders,
  onSelectOAuth, onSelectApiKey, onAddCustom, onClose,
}: AddProviderPickerProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const q = search.trim().toLowerCase();

  const availableOAuth = oauthProviders.filter((p) => !p.loggedIn && (!q || p.name.toLowerCase().includes(q)));
  const availableApiKey = apiKeyProviders.filter((p) => !p.configured && (!q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
  const showCustom = !q || "custom".includes(q) || "openai-compatible".includes(q) || "anthropic-compatible".includes(q);

  const totalCount = availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0);

  return (
    <DialogShell
      open
      title={t("providers.add")}
      description={t("providers.addHint")}
      onClose={onClose}
      size="wide"
      mobileMode="sheet"
      initialFocusRef={inputRef}
      bodyClassName={styles.body}
    >
        {/* Search */}
        <div className={styles.searchBar}>
          <Search size={16} strokeWidth={1.8} aria-hidden="true" className={styles.searchIcon} />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("providers.searchPlaceholder")}
            aria-label={t("providers.search")}
            className={styles.searchInput}
          />
          {search && (
            <IconButton
              label={t("providers.clearSearch")}
              icon={<X strokeWidth={1.8} />}
              size="compact"
              onClick={() => setSearch("")}
            />
          )}
        </div>

        {/* Card grid */}
        <div className={styles.cardGridArea}>
          {totalCount === 0 ? (
            <div className={styles.emptyMessage}>{t("providers.none")}</div>
          ) : (
            <div className={styles.cardGrid}>
              {showCustom && (
                <div className={styles.sectionHeader}>{t("providers.custom")}</div>
              )}
              {showCustom && (
                <button
                  type="button"
                  onClick={() => { onAddCustom(); onClose(); }}
                  className={`hover-border-accent-bg ${styles.card}`}
                >
                  <div className={styles.cardInfo}>
                    <div className={styles.cardTitle}>{t("providers.compatible")}</div>
                    <div className={styles.cardSubtitle}>{t("providers.customEndpoint")}</div>
                  </div>
                  <span className={styles.plusIconBox}>
                    <Plus size={15} strokeWidth={1.8} aria-hidden="true" className={styles.plusIcon} />
                  </span>
                </button>
              )}

              {availableOAuth.length > 0 && (
                <div className={`${styles.sectionHeader} ${showCustom ? styles.sectionHeaderPadding : ""}`}>{t("providers.subscriptions")}</div>
              )}
              {availableOAuth.map((p) => (
                <button type="button" key={p.id} onClick={() => { onSelectOAuth(p.id); onClose(); }}
                  className={`hover-border-accent-bg ${styles.card}`}
                >
                  <div className={styles.cardInfo}>
                    <div className={styles.cardTitle}>{p.name}</div>
                    <div className={styles.cardSubtitle}>OAuth</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

              {availableApiKey.length > 0 && (
                <div className={`${styles.sectionHeader} ${availableOAuth.length > 0 ? styles.sectionHeaderPadding : ""}`}>{t("apiKey.title")}</div>
              )}
              {availableApiKey.map((p) => (
                <button type="button" key={p.id} onClick={() => { onSelectApiKey(p.id); onClose(); }}
                  className={`hover-border-accent-bg ${styles.card}`}
                >
                  <div className={styles.cardInfo}>
                    <div className={styles.cardTitle}>{p.displayName}</div>
                    <div className={styles.cardSubtitle}>{t("providers.modelCount").replace("{count}", String(p.modelCount))}</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

            </div>
          )}
        </div>
    </DialogShell>
  );
}
