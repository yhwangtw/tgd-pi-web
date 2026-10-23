import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { iconSourceViolations, isProductIconSource, isVerifiedProviderArtwork, VENDORED_PROVIDER_ARTWORK } from "../design-icon-policy.mjs";
const artwork = readFileSync(VENDORED_PROVIDER_ARTWORK.file, "utf8");
const license = readFileSync(VENDORED_PROVIDER_ARTWORK.licenseFile, "utf8");

describe("shared UI icon contract", () => {
  it("exempts only the exact source-compared, licensed provider artwork", () => {
    expect(iconSourceViolations(VENDORED_PROVIDER_ARTWORK.file, artwork, license)).toEqual([]);
    expect(isVerifiedProviderArtwork(VENDORED_PROVIDER_ARTWORK.file, artwork, license)).toBe(true);
    expect(isVerifiedProviderArtwork("components/ui/Other.tsx", artwork, license)).toBe(false);
    expect(isVerifiedProviderArtwork(VENDORED_PROVIDER_ARTWORK.file, artwork + "<span>New UI</span>", license)).toBe(false);
    expect(isVerifiedProviderArtwork(VENDORED_PROVIDER_ARTWORK.file, artwork, "")).toBe(false);
    expect(iconSourceViolations("components/modals/OtherIcon.tsx", artwork, license)).toHaveLength(30);
    expect(iconSourceViolations("components/other/provider-icons.tsx", artwork, license)).toHaveLength(30);
  });
  it("rejects edits to exempt artwork or missing/changed attribution", () => {
    expect(iconSourceViolations(VENDORED_PROVIDER_ARTWORK.file, artwork.replace("#4285F4", "#000000"), license)[0]).toContain("artwork changed");
    expect(iconSourceViolations(VENDORED_PROVIDER_ARTWORK.file, artwork + "\n<svg />", license)[0]).toContain("artwork changed");
    expect(iconSourceViolations(VENDORED_PROVIDER_ARTWORK.file, artwork)[0]).toContain("MIT license");
    expect(iconSourceViolations(VENDORED_PROVIDER_ARTWORK.file, artwork, license.replace("LobeHub", "Other"))[0]).toContain("MIT license");
  });
  it("keeps ordinary UI SVGs blocked and excludes only test sources", () => {
    expect(iconSourceViolations("components/ui/NewIcon.tsx", "const Icon = () => (\n<svg />)"))
      .toEqual(["components/ui/NewIcon.tsx:2 use the shared icon library instead of handwritten SVG"]);
    for (const file of ["components/ui/__tests__/icon.test.tsx", "components/ui/icon.test.tsx", "e2e/icon.tsx"]) {
      expect(isProductIconSource(file)).toBe(false);
      expect(iconSourceViolations(file, "<svg />")).toEqual([]);
    }
    expect(isProductIconSource("components/ui/Icon.tsx")).toBe(true);
  });
});
