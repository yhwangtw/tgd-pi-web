/** Shared by response headers and inline previews. Never grant same-origin. */
export function previewContentSecurityPolicy(allowScripts = false): string {
  return [
    allowScripts ? "sandbox allow-scripts" : "sandbox",
    "default-src 'none'",
    allowScripts ? "script-src 'unsafe-inline'" : "script-src 'none'",
    "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:",
    "media-src data: blob:", "connect-src 'none'", "frame-src 'none'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
  ].join("; ");
}

/** Meta policies cannot set sandbox/frame-ancestors; the iframe owns those. */
export function isolatedPreviewDocument(content: string): string {
  const policy = previewContentSecurityPolicy(true).split("; ")
    .filter((directive) => !directive.startsWith("sandbox") && !directive.startsWith("frame-ancestors"))
    .join("; ");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">${content}`;
}
