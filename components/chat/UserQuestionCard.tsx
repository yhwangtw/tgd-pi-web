"use client";

import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type ComponentProps, type RefObject } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { DialogShell } from "@/components/ui/DialogShell";
import { useI18n } from "@/lib/i18n";
import type { WebExtensionUIDialogRequest, WebExtensionUIResponse } from "@/lib/web-extension-ui-types";
import { AskUserFields, QuestionChoiceList } from "./UserQuestionFields";
import styles from "./ExtensionUIPanel.module.css";

interface Props {
  request: WebExtensionUIDialogRequest;
  pendingCount: number;
  onRespond: (response: WebExtensionUIResponse) => Promise<void>;
  cardRef?: RefObject<UserQuestionCardHandle | null>;
}

export interface UserQuestionCardHandle { reveal: () => void }

export function UserQuestionCard({ request, pendingCount, onRespond, cardRef }: Props) {
  const { t } = useI18n();
  const formId = useId();
  const firstControlRef = useRef<HTMLButtonElement | null>(null);
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const submittingRef = useRef(false);
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
    submittingRef.current = false;
    setAnswers(initial);
    setCustomAnswers(new Set());
    setActiveQuestionIndex(0);
    setSubmitting(false);
    setError(null);
  }, [request]);

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

  const respond = useCallback(async (response: WebExtensionUIResponse) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onRespond(response);
    } catch (cause) {
      submittingRef.current = false;
      setError(cause instanceof Error ? cause.message : t("extensionUI.responseFailed"));
      setSubmitting(false);
    }
  }, [onRespond, t]);

  const cancel = useCallback(() => respond({
    type: "extension_ui_response",
    id: request.id,
    cancelled: true,
  }), [request.id, respond]);
  const closeDialog = useCallback(() => { void cancel(); }, [cancel]);

  // Initial questions never steal focus. Advancing a step is an explicit user
  // action, so move to the next choice/input without jumping the transcript.
  useEffect(() => {
    if (request.method !== "ask_user" || activeQuestionIndex === 0) return;
    const frame = requestAnimationFrame(() => {
      (firstControlRef.current ?? firstInputRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeQuestionIndex, request.method]);

  const initialFocusRef = (
    request.method === "input" || request.method === "editor"
      ? firstInputRef
      : request.method === "ask_user" && (activeQuestion?.options.length ?? 0) === 0
        ? firstInputRef
        : firstControlRef
  ) as RefObject<HTMLElement | null>;
  const title = request.method === "ask_user" ? t("extensionUI.waiting") : request.title;
  const description = request.method === "ask_user" ? t("extensionUI.waitingHint") : undefined;
  const headerActions = (
    <QuestionStatus
      pendingCount={pendingCount}
      questionIndex={request.method === "ask_user" ? activeQuestionIndex : undefined}
      questionCount={request.method === "ask_user" ? request.questions.length : undefined}
    />
  );

  if (request.method === "confirm") {
    return (
      <DialogShell
        open
        title={request.title}
        onClose={closeDialog}
        canClose={!submitting}
        size="compact"
        mobileMode="sheet"
        initialFocusRef={firstControlRef as RefObject<HTMLElement | null>}
        headerActions={headerActions}
        bodyClassName={styles.questionDialogBody}
        footer={(
          <>
            <button ref={firstControlRef} type="button" className={styles.secondaryButton} disabled={submitting}
              onClick={() => void respond({ type: "extension_ui_response", id: request.id, confirmed: false })}>
              {t("extensionUI.no")}
            </button>
            <button type="button" className={styles.primaryButton} disabled={submitting}
              onClick={() => void respond({ type: "extension_ui_response", id: request.id, confirmed: true })}>
              {submitting ? t("extensionUI.sending") : t("extensionUI.yes")}
            </button>
          </>
        )}
      >
        <p className={styles.message}>{request.message}</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </DialogShell>
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
    <QuestionSurface
      inline={request.method === "ask_user"}
      cardRef={cardRef}
      open
      title={title}
      description={description}
      onClose={closeDialog}
      canClose={!submitting}
      size={request.method === "ask_user" ? "default" : "compact"}
      mobileMode="sheet"
      initialFocusRef={initialFocusRef}
      headerActions={headerActions}
      bodyClassName={styles.questionDialogBody}
      footer={(
        <>
          {request.method === "ask_user" && activeQuestionIndex > 0 && (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={submitting}
              onClick={() => setActiveQuestionIndex((current) => Math.max(0, current - 1))}
            >
              <ArrowLeft size={15} strokeWidth={2} aria-hidden />
              {t("extensionUI.back")}
            </button>
          )}
          <button form={formId} type="submit" className={styles.primaryButton} disabled={!canSubmit || submitting}>
            <span>
              {submitting
                ? t("extensionUI.sending")
                : request.method === "ask_user" && !isLastQuestion
                  ? t("extensionUI.next")
                  : t("extensionUI.submit")}
            </span>
            {!submitting && <ArrowRight size={15} strokeWidth={2} aria-hidden />}
          </button>
        </>
      )}
    >
      <form id={formId} onSubmit={submit} className={styles.questionForm}>
        <fieldset className={`${styles.formBody} ${styles.questionFields}`} disabled={submitting}>
          {request.method === "select" && (
            <QuestionChoiceList
              ariaLabel={request.title}
              options={request.options.map((label) => ({ label }))}
              selected={answers.value}
              firstRef={firstControlRef}
              onSelect={(value) => setAnswers({ value })}
            />
          )}
          {request.method === "input" && (
            <input
              ref={firstInputRef as RefObject<HTMLInputElement>}
              className={styles.textInput}
              aria-label={request.title}
              value={answers.value ?? ""}
              placeholder={request.placeholder}
              onChange={(event) => setAnswers({ value: event.target.value })}
            />
          )}
          {request.method === "editor" && (
            <textarea
              ref={firstInputRef as RefObject<HTMLTextAreaElement>}
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
        </fieldset>
      </form>
    </QuestionSurface>
  );
}

/** Only structured questions are non-modal; explicit extension confirmations
 * retain DialogShell's focus isolation and cancellation contract. */
function QuestionSurface({ inline, cardRef, ...props }: ComponentProps<typeof DialogShell> & {
  inline: boolean;
  cardRef?: RefObject<UserQuestionCardHandle | null>;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const bodyId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  useImperativeHandle(cardRef, () => ({
    reveal: () => {
      setCollapsed(false);
      requestAnimationFrame(() => {
        rootRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
        // Focus the disclosure, not an input that opens the mobile keyboard.
        toggleRef.current?.focus({ preventScroll: true });
      });
    },
  }), []);
  if (!inline) return <DialogShell {...props} />;
  return (
    <section ref={rootRef} className={`${styles.card} ${styles.inlineQuestion}`} aria-labelledby={titleId} data-testid="inline-user-question">
      <header className={styles.cardHeader}>
        <div className={styles.headingCopy}>
          <h3 id={titleId} className={styles.cardTitle}>{props.title}</h3>
          {props.description && <p className={styles.cardDescription}>{props.description}</p>}
        </div>
        <div className={styles.headerActions}>
          {props.headerActions}
          <button ref={toggleRef} type="button" className={styles.deferButton} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setCollapsed(value => !value)}>
            <span>{t(collapsed ? "extensionUI.expandQuestion" : "extensionUI.answerLater")}</span>
            {collapsed ? <ChevronDown size={15} aria-hidden /> : <ChevronUp size={15} aria-hidden />}
          </button>
        </div>
      </header>
      {/* Keep fields mounted while deferred: hiding is never an answer or a
          cancellation and must preserve both the draft and the current step. */}
      <div id={bodyId} className={styles.inlineQuestionBody} hidden={collapsed}>
        <div className={props.bodyClassName}>{props.children}</div>
        <footer className={`${styles.actions} ${styles.questionActions}`}>
          <button type="button" className={styles.cancelButton} disabled={props.canClose === false} onClick={props.onClose}>{t("extensionUI.cancelQuestion")}</button>
          {props.footer}
        </footer>
      </div>
    </section>
  );
}

function QuestionStatus({ pendingCount, questionIndex, questionCount }: {
  pendingCount: number;
  questionIndex?: number;
  questionCount?: number;
}) {
  const { t } = useI18n();
  const showStep = questionIndex !== undefined && questionCount !== undefined && questionCount > 1;
  if (!showStep && pendingCount <= 1) return null;
  return (
    <div className={styles.dialogStatus} role="status" aria-live="polite">
      {showStep && (
        <span
          className={styles.stepCounter}
          aria-label={`${t("extensionUI.question")} ${questionIndex + 1} / ${questionCount}`}
        >
          {questionIndex + 1}<span aria-hidden> / </span>{questionCount}
        </span>
      )}
      {pendingCount > 1 && (
        <span className={styles.pendingCount} aria-label={`${pendingCount} ${t("extensionUI.pending")}`}>
          +{pendingCount - 1}
        </span>
      )}
    </div>
  );
}
