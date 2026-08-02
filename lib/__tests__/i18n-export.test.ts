// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { setLocale, translate } from "@/lib/i18n";

describe("export labels", () => {
  afterEach(() => setLocale("en"));

  it("describes the result before naming its file format in English", () => {
    setLocale("en");
    expect(translate("topbar.exportTitle")).toBe("Choose export format");
    expect(translate("topbar.exportHtmlLabel")).toBe("HTML");
    expect(translate("topbar.exportHtmlHint")).toContain("Downloads .html");
    expect(translate("topbar.exportMdLabel")).toBe("Markdown");
    expect(translate("topbar.exportMdHint")).toContain("Downloads .md");
  });

  it("uses task-oriented Traditional Chinese labels", () => {
    setLocale("zh");
    expect(translate("topbar.exportTitle")).toBe("選擇匯出格式");
    expect(translate("topbar.exportHtmlLabel")).toBe("HTML");
    expect(translate("topbar.exportHtmlHint")).toContain("點擊即下載 .html");
    expect(translate("topbar.exportMdLabel")).toBe("Markdown");
    expect(translate("topbar.exportMdHint")).toContain("點擊即下載 .md");
  });
});
