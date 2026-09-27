/** Read at the time of interaction so changes in OS preferences apply immediately. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export function motionScrollBehavior(behavior: ScrollBehavior = "smooth"): ScrollBehavior {
  return behavior === "smooth" && prefersReducedMotion() ? "instant" : behavior;
}
