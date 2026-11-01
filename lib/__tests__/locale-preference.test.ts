import { describe, expect, it } from "vitest";
import { resolveLocalePreference } from "../locale-preference";

describe("initial locale preference", () => {
  it.each([
    ["en", ["zh-TW"], "en"],
    ["zh", ["en-US"], "zh"],
    [null, ["zh-Hant-TW", "en-US"], "zh"],
    [null, ["ja-JP", "en-GB", "zh-TW"], "en"],
    [null, ["ja-JP", "ZH-tw", "en"], "zh"],
    ["invalid", ["zh-HK"], "zh"],
    [null, ["ja-JP", "fr-FR"], "en"],
    [null, [], "en"],
  ])("resolves saved=%s languages=%j as %s", (saved, languages, expected) => {
    expect(resolveLocalePreference(saved, languages as string[])).toBe(expected);
  });
});
