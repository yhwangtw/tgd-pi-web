"use client";

import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from "react";
import { CheckCircle2, Circle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { AskUserOption, WebExtensionUIDialogRequest } from "@/lib/web-extension-ui-types";
import styles from "./ExtensionUIPanel.module.css";

interface ChoiceListProps {
  questionId?: string;
  ariaLabel?: string;
  options: AskUserOption[];
  selected?: string;
  firstRef?: RefObject<HTMLButtonElement | null>;
  onSelect: (value: string) => void;
  allowOther?: boolean;
  otherLabel?: string;
  otherSelected?: boolean;
  onSelectOther?: () => void;
}

export function QuestionChoiceList({
  questionId,
  ariaLabel,
  options,
  selected,
  firstRef,
  onSelect,
  allowOther = false,
  otherLabel,
  otherSelected = false,
  onSelectOther,
}: ChoiceListProps) {
  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
    event.preventDefault();
    const choices = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const current = choices.indexOf(event.currentTarget);
    const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
    const next = choices[(current + direction + choices.length) % choices.length];
    next?.focus();
    next?.click();
  };

  return (
    <div className={styles.choices} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option, index) => (
        <button
          key={option.label}
          ref={index === 0 ? firstRef : undefined}
          type="button"
          role="radio"
          aria-checked={selected === option.label}
          data-question-id={questionId}
          data-value={option.label}
          className={`${styles.choice} ${selected === option.label ? styles.choiceSelected : ""}`}
          onClick={() => onSelect(option.label)}
          onKeyDown={moveSelection}
        >
          <span className={styles.choiceMark} aria-hidden>
            {selected === option.label
              ? <CheckCircle2 size={19} strokeWidth={2.1} />
              : <Circle size={19} strokeWidth={1.7} />}
          </span>
          <span className={styles.choiceCopy}>
            <span className={styles.choiceLabel}>{option.label}</span>
            {option.description && <span className={styles.choiceDescription}>{option.description}</span>}
          </span>
        </button>
      ))}
      {allowOther && (
        <button
          type="button"
          role="radio"
          aria-checked={otherSelected}
          data-question-id={questionId}
          data-value="__other__"
          className={`${styles.choice} ${otherSelected ? styles.choiceSelected : ""}`}
          onClick={onSelectOther}
          onKeyDown={moveSelection}
        >
          <span className={styles.choiceMark} aria-hidden>
            {otherSelected
              ? <CheckCircle2 size={19} strokeWidth={2.1} />
              : <Circle size={19} strokeWidth={1.7} />}
          </span>
          <span className={styles.choiceCopy}>
            <span className={styles.choiceLabel}>{otherLabel}</span>
          </span>
        </button>
      )}
    </div>
  );
}

export function AskUserFields({ request, activeQuestionIndex, answers, setAnswers, customAnswers, setCustomAnswers, firstControlRef, firstInputRef }: {
  request: Extract<WebExtensionUIDialogRequest, { method: "ask_user" }>;
  activeQuestionIndex: number;
  answers: Record<string, string>;
  setAnswers: Dispatch<SetStateAction<Record<string, string>>>;
  customAnswers: Set<string>;
  setCustomAnswers: Dispatch<SetStateAction<Set<string>>>;
  firstControlRef: RefObject<HTMLButtonElement | null>;
  firstInputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}) {
  const { t } = useI18n();
  const question = request.questions[activeQuestionIndex];
  if (!question) return null;
  return (
    <fieldset key={question.id} className={styles.questionGroup}>
      <legend className={styles.questionLegend}>
        {question.header && <span className={styles.questionHeader}>{question.header}</span>}
        <span className={styles.questionPrompt}>{question.question}</span>
      </legend>
      {question.options.length > 0 && (
        <QuestionChoiceList
          questionId={question.id}
          ariaLabel={question.question}
          options={question.options}
          selected={customAnswers.has(question.id) ? undefined : answers[question.id]}
          firstRef={firstControlRef}
          allowOther={question.allowOther}
          otherLabel={t("extensionUI.other")}
          otherSelected={customAnswers.has(question.id)}
          onSelect={(value) => {
            setCustomAnswers((current) => { const next = new Set(current); next.delete(question.id); return next; });
            setAnswers((current) => ({ ...current, [question.id]: value }));
          }}
          onSelectOther={() => {
            setCustomAnswers((current) => new Set(current).add(question.id));
            setAnswers((current) => ({ ...current, [question.id]: "" }));
            requestAnimationFrame(() => firstInputRef.current?.focus());
          }}
        />
      )}
      {question.allowOther && (question.options.length === 0 || customAnswers.has(question.id)) && (
        <input
          ref={firstInputRef as RefObject<HTMLInputElement>}
          data-question-id={question.id}
          className={styles.textInput}
          aria-label={question.question}
          value={answers[question.id] ?? ""}
          placeholder={t("extensionUI.typeAnswer")}
          onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
        />
      )}
    </fieldset>
  );
}
