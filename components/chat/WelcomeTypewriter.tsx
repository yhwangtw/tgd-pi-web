"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import styles from "./ChatWindow.module.css";

const query = "(prefers-reduced-motion: reduce)";
function subscribe(callback: () => void) {
  const preference = window.matchMedia(query);
  preference.addEventListener("change", callback);
  return () => preference.removeEventListener("change", callback);
}
const getSnapshot = () => window.matchMedia(query).matches;
// SSR and hydration start with readable, stable content before preferences load.
const getServerSnapshot = () => true;

export function WelcomeTypewriter({ phrases }: { phrases: readonly string[] }) {
  const reducedMotion = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [text, setText] = useState(phrases[0] ?? "");
  const [deleting, setDeleting] = useState(false);
  const [caretOn, setCaretOn] = useState(true);
  const current = phrases[phraseIdx] ?? phrases[0] ?? "";

  useEffect(() => {
    if (reducedMotion || !current) return;
    const blink = setInterval(() => setCaretOn((value) => !value), 530);
    return () => clearInterval(blink);
  }, [reducedMotion, current]);

  useEffect(() => {
    if (reducedMotion || !current) return;
    let timeout: ReturnType<typeof setTimeout>;
    if (!deleting && text === current) {
      timeout = setTimeout(() => setDeleting(true), 1800);
    } else if (deleting && text === "") {
      setDeleting(false);
      setPhraseIdx((index) => (index + 1) % phrases.length);
    } else {
      const next = deleting ? current.slice(0, text.length - 1) : current.slice(0, text.length + 1);
      timeout = setTimeout(() => setText(next), deleting ? 28 : 55);
    }
    return () => clearTimeout(timeout);
  }, [text, deleting, current, phrases.length, reducedMotion]);

  return (
    <span className={styles.typewriterText} data-testid="welcome-typewriter">
      {reducedMotion ? current : text}
      {!reducedMotion && current && <span aria-hidden="true" style={{ opacity: caretOn ? 1 : 0 }} className={styles.typewriterCaret}>▍</span>}
    </span>
  );
}
