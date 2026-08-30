"use client";

import { useState, useCallback } from "react";
import { DialogShell } from "@/components/ui/DialogShell";
import { usePrompts } from "@/hooks/usePrompts";
import { useI18n } from "@/lib/i18n";
import styles from "./PromptsConfig.module.css";

export function PromptsConfig({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { prompts, savePrompt, deletePrompt } = usePrompts();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  const resetForm = useCallback(() => { setEditingId(null); setName(""); setBody(""); }, []);

  const startEdit = useCallback((id: string) => {
    const p = prompts.find((x) => x.id === id);
    if (!p) return;
    setEditingId(p.id);
    setName(p.name);
    setBody(p.body);
  }, [prompts]);

  const save = useCallback(async () => {
    if (!name.trim() || !body.trim()) return;
    setSaving(true);
    await savePrompt({ id: editingId ?? undefined, name, body });
    setSaving(false);
    resetForm();
  }, [name, body, editingId, savePrompt, resetForm]);

  return (
    <DialogShell
      open
      title={t("prompts.title")}
      onClose={onClose}
      size="default"
      mobileMode="fullscreen"
      bodyClassName={styles.body}
    >
          {/* Editor */}
          <div className={styles.editor}>
            <div className={styles.nameRow}>
              <span className={styles.slash}>/</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("prompts.namePlaceholder")}
                aria-label={t("prompts.nameLabel")}
                className={styles.nameInput}
                spellCheck={false}
              />
              <span className={styles.nameHint}>
                {t("prompts.nameHintBefore")} <code>/{name.trim() ? name.trim().toLowerCase().replace(/\s+/g, "-") : "name"}</code> {t("prompts.nameHintAfter")}
              </span>
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("prompts.bodyPlaceholder")}
              aria-label={t("prompts.bodyLabel")}
              className={styles.bodyInput}
              rows={5}
              spellCheck={false}
            />
            <div className={styles.editorActions}>
              {editingId && (
                <button onClick={resetForm} className={styles.cancelBtn}>{t("prompts.cancelEdit")}</button>
              )}
              <button onClick={save} disabled={saving || !name.trim() || !body.trim()} className={styles.saveBtn}>
                {editingId ? t("prompts.saveChanges") : t("prompts.addTemplate")}
              </button>
            </div>
          </div>

          {/* List */}
          <div className={styles.list}>
            {prompts.length === 0 ? (
              <div className={styles.empty}>{t("prompts.emptyBefore")} <code>{t("prompts.slashName")}</code> {t("prompts.emptyAfter")}</div>
            ) : (
              prompts.map((p) => (
                <div key={p.id} className={`${styles.item} ${editingId === p.id ? styles.itemEditing : ""}`}>
                  <div className={styles.itemMain}>
                    <span className={styles.itemName}>/{p.name}</span>
                    <span className={styles.itemBody}>{p.body.split("\n")[0]}</span>
                  </div>
                  <div className={styles.itemActions}>
                    <button onClick={() => startEdit(p.id)} className={styles.itemBtn} title={t("prompts.edit")}>{t("prompts.edit")}</button>
                    <button onClick={() => { if (editingId === p.id) resetForm(); void deletePrompt(p.id); }} className={`${styles.itemBtn} ${styles.itemBtnDanger}`} title={t("prompts.delete")}>{t("prompts.delete")}</button>
                  </div>
                </div>
              ))
            )}
          </div>
    </DialogShell>
  );
}
