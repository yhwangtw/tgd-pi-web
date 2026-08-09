"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { WebExtensionUIDialogRequest, WebExtensionUIResponse } from "@/lib/web-extension-ui-types";
import { AskUserFields, QuestionChoiceList } from "./UserQuestionFields";
import styles from "./ExtensionUIPanel.module.css";

interface Props {
  request: WebExtensionUIDialogRequest;
  pendingCount: number;
  onRespond: (response: WebExtensionUIResponse) => Promise<void>;
}

export function UserQuestionCard({ request, pendingCount, onRespond }: Props) {
  const { t } = useI18n();
  const firstControlRef = useRef<HTMLButtonElement | null>(null);
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [customAnswers, setCustomAnswers] = useState<Set<string>>(new Set());
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initial: Record<string, string> = {};
    if (request.method === "editor") initial.value = request.prefill ?? "";
    else if (request.method === "input" || request.method === "select") initial.value = "";
    else if (request.method === "ask_user") {
      for (const question of request.questions) initial[question.id] = "";
    }
    setAnswers(initial);
    setCustomAnswers(new Set());
    setActiveQuestionIndex(0);
    setSubmitting(false);
    setError(null);
  }, [request]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => (firstControlRef.current ?? firstInputRef.current)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeQuestionIndex, request]);

  const activeQuestion = request.method === "ask_user"
    ? request.questions[activeQuestionIndex]
    : undefined;
  const activeQuestionAnswered = activeQuestion
    ? Boolean(answers[activeQuestion.id]?.trim())
    : false;
  const isLastQuestion = request.method !== "ask_user"
    || activeQuestionIndex === request.questions.length - 1;

  const canSubmit = useMemo(() => {
    if (request.method === "select") return Boolean(answers.value);
    if (request.method === "ask_user") return activeQuestionAnswered;
    return request.method !== "confirm";
  }, [activeQuestionAnswered, answers, request]);

  const respond = async (response: WebExtensionUIResponse) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onRespond(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("extensionUI.responseFailed"));
      setSubmitting(false);
    }
  };

  const cancel = () => respond({ type: "extension_ui_response", id: request.id, cancelled: true });
  const title = request.method === "ask_user" ? t("extensionUI.agentQuestion") : request.title;

  if (request.method === "confirm") {
    return (
      <section
        className={styles.card}
        role="dialog"
        aria-labelledby={`extension-question-${request.id}`}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); void cancel(); } }}
      >
        <CardHeader id={request.id} title={request.title} pendingCount={pendingCount} onCancel={cancel} />
        <p className={styles.message}>{request.message}</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button ref={firstControlRef} type="button" className={styles.secondaryButton} disabled={submitting}
            onClick={() => respond({ type: "extension_ui_response", id: request.id, confirmed: false })}>
            {t("extensionUI.no")}
          </button>
          <button type="button" className={styles.primaryButton} disabled={submitting}
            onClick={() => respond({ type: "extension_ui_response", id: request.id, confirmed: true })}>
            {submitting ? t("extensionUI.sending") : t("extensionUI.yes")}
          </button>
        </div>
      </section>
    );
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (request.method === "select" || request.method === "input" || request.method === "editor") {
      void respond({ type: "extension_ui_response", id: request.id, value: answers.value ?? "" });
      return;
    }
    if (!isLastQuestion) {
      setActiveQuestionIndex((current) => current + 1);
      return;
    }
    const normalized = Object.fromEntries(
      Object.entries(answers).map(([key, value]) => [key, value.trim()]),
    );
    void respond({ type: "extension_ui_response", id: request.id, answers: normalized });
  };

  return (
    <section
      className={`${styles.card} ${styles.questionCard}`}
      role="dialog"
      aria-labelledby={`extension-question-${request.id}`}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); void cancel(); } }}
    >
      <CardHeader id={request.id} title={title} pendingCount={pendingCount} onCancel={cancel} />
      <form onSubmit={submit}>
        <div className={styles.formBody}>
          {request.method === "ask_user" && (
            <div className={styles.questionProgress} aria-label={`${t("extensionUI.question")} ${activeQuestionIndex + 1} / ${request.questions.length}`}>
              <div className={styles.questionProgressMeta}>
                <span>{t("extensionUI.question")} {activeQuestionIndex + 1} / {request.questions.length}</span>
                <span>{t("extensionUI.chooseOne")}</span>
              </div>
              <div className={styles.progressTrack} aria-hidden>
                {request.questions.map((question, index) => (
                  <span
                    key={question.id}
                    className={`${styles.progressStep} ${index <= activeQuestionIndex ? styles.progressStepActive : ""}`}
                  />
                ))}
              </div>
            </div>
          )}
          {request.method === "select" && (
            <QuestionChoiceList
              options={request.options.map((label) => ({ label }))}
              selected={answers.value}
              firstRef={firstControlRef}
              onSelect={(value) => setAnswers({ value })}
            />
          )}
          {request.method === "input" && (
            <input
              ref={firstInputRef as React.RefObject<HTMLInputElement>}
              className={styles.textInput}
              aria-label={request.title}
              value={answers.value ?? ""}
              placeholder={request.placeholder}
              onChange={(event) => setAnswers({ value: event.target.value })}
            />
          )}
          {request.method === "editor" && (
            <textarea
              ref={firstInputRef as React.RefObject<HTMLTextAreaElement>}
              className={styles.editor}
              aria-label={request.title}
              value={answers.value ?? ""}
              onChange={(event) => setAnswers({ value: event.target.value })}
              rows={5}
            />
          )}
          {request.method === "ask_user" && (
            <AskUserFields
              request={request}
              activeQuestionIndex={activeQuestionIndex}
              answers={answers}
              setAnswers={setAnswers}
              customAnswers={customAnswers}
              setCustomAnswers={setCustomAnswers}
              firstControlRef={firstControlRef}
              firstInputRef={firstInputRef}
            />
          )}
          {error && <p className={styles.error} role="alert">{error}</p>}
        </div>
        <div className={`${styles.actions} ${styles.questionActions}`}>
          <button type="button" className={styles.cancelButton} disabled={submitting} onClick={() => void cancel()}>
            {t("extensionUI.cancel")}
          </button>
          {request.method === "ask_user" && activeQuestionIndex > 0 && (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={submitting}
              onClick={() => setActiveQuestionIndex((current) => Math.max(0, current - 1))}
            >
              {t("extensionUI.back")}
            </button>
          )}
          <button type="submit" className={styles.primaryButton} disabled={!canSubmit || submitting}>
            {submitting
              ? t("extensionUI.sending")
              : request.method === "ask_user" && !isLastQuestion
                ? t("extensionUI.next")
                : t("extensionUI.submit")}
          </button>
        </div>
      </form>
    </section>
  );
}

function CardHeader({ id, title, pendingCount, onCancel }: {
  id: string;
  title: string;
  pendingCount: number;
  onCancel: () => Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.cardHeader}>
      <div className={styles.cardHeading}>
        <span className={styles.waitingMark} aria-hidden />
        <div className={styles.headingCopy}>
          <div className={styles.eyebrow}>{t("extensionUI.waiting")}</div>
          <h2 id={`extension-question-${id}`} className={styles.cardTitle}>{title}</h2>
        </div>
      </div>
      <div className={styles.headerActions}>
        {pendingCount > 1 && <span className={styles.pendingCount}>+{pendingCount - 1}</span>}
        <button type="button" className={styles.closeButton} onClick={() => void onCancel()}
          aria-label={t("extensionUI.cancel")} title={t("extensionUI.cancel")}>
          ×
        </button>
      </div>
    </div>
  );
}
