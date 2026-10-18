import type { KeyboardEvent } from "react";

export function handleRadioGroupKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((radio) => !radio.disabled);
  const index = radios.indexOf(event.target as HTMLButtonElement);
  if (index < 0 || !radios.length) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1
    : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + radios.length) % radios.length;
  radios[next].focus();
  radios[next].click();
}
