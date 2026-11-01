/** A saved choice wins; otherwise use the browser's first supported language. */
export function resolveLocalePreference(saved: string | null, languages: readonly string[]): "en" | "zh" {
  if (saved === "en" || saved === "zh") return saved;
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (base === "zh" || base === "en") return base;
  }
  return "en";
}
