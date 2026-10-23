import { createHash } from "node:crypto";

// This one file contains source-compared @lobehub/icons@5.10.0 artwork (MIT).
// Provenance and the retained LobeHub copyright are in vendor/lobe-icons/.
// Digests intentionally require a new source review before changing this copy;
// naming a new UI component provider-icons.tsx does not grant an exception.
export const VENDORED_PROVIDER_ARTWORK = Object.freeze({
  file: "components/modals/provider-icons.tsx",
  sourceSha256: "a24489a8a706bb72994ae5d9ddcbf9aaa12adc8a286beabc794c624f6b1edb63",
  licenseFile: "vendor/lobe-icons/LICENSE",
  licenseSha256: "add9d7531d1b21646317a8958e38fc727506fa39d24bdecb44154d943c82753a",
});
const sha256 = source => createHash("sha256").update(source).digest("hex");

// Match the existing i18n scanner's test-source exclusion.
export function isProductIconSource(file) {
  return file.endsWith(".tsx") && !file.split(/[\\/]/).some(part => part === "__tests__" || part === "e2e") && !/\.test\.tsx$/.test(file);
}

export function isVerifiedProviderArtwork(file, source, licenseSource) {
  return file.replaceAll("\\", "/") === VENDORED_PROVIDER_ARTWORK.file
    && sha256(source) === VENDORED_PROVIDER_ARTWORK.sourceSha256
    && sha256(licenseSource ?? "") === VENDORED_PROVIDER_ARTWORK.licenseSha256;
}

export function iconSourceViolations(file, source, licenseSource = "") {
  if (!isProductIconSource(file)) return [];
  if (file.replaceAll("\\", "/") === VENDORED_PROVIDER_ARTWORK.file) {
    if (sha256(source) !== VENDORED_PROVIDER_ARTWORK.sourceSha256) return [`${file}: vendored artwork changed; compare all SVGs with the licensed upstream source before renewing the exception`];
    if (sha256(licenseSource) !== VENDORED_PROVIDER_ARTWORK.licenseSha256) return [`${file}: retain the verified LobeHub MIT license at ${VENDORED_PROVIDER_ARTWORK.licenseFile}`];
    return [];
  }
  return [...source.matchAll(/<svg\b/g)].map(match => {
    const line = source.slice(0, match.index).split("\n").length;
    return `${file}:${line} use the shared icon library instead of handwritten SVG`;
  });
}
