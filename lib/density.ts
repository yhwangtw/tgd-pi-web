"use client";

import { useSyncExternalStore } from "react";

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const DEFAULT_DENSITY: Density = "comfortable";

export function normalizeDensity(value: string | null | undefined): Density {
  return value && (DENSITIES as readonly string[]).includes(value)
    ? value as Density
    : DEFAULT_DENSITY;
}

const listeners = new Set<() => void>();
let density: Density = DEFAULT_DENSITY;

if (typeof window !== "undefined") {
  try {
    density = normalizeDensity(localStorage.getItem("pi-density"));
  } catch {
    // Storage is best effort; preserve the more spacious default.
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): Density {
  return density;
}

function getServerSnapshot(): Density {
  return DEFAULT_DENSITY;
}

export function setDensity(next: Density): void {
  density = next;
  try {
    localStorage.setItem("pi-density", next);
  } catch {
    // Preference persistence is best effort.
  }

  if (next === DEFAULT_DENSITY) {
    document.documentElement.removeAttribute("data-density");
  } else {
    document.documentElement.setAttribute("data-density", next);
  }
  listeners.forEach((callback) => callback());
}

export function useDensity(): { density: Density; setDensity: (next: Density) => void } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { density: current, setDensity };
}
