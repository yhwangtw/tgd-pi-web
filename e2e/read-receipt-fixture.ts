interface ReadReceiptRequest {
  method(): string;
  url(): string;
  headers(): Record<string, string>;
  postData(): string | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The only automatic write allowed by otherwise read-only browser fixtures. */
export function isFixtureReadReceipt(request: ReadReceiptRequest): boolean {
  if (request.method() !== "POST") return false;
  const url = new URL(request.url());
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.pathname !== "/api/sessions/reads" || url.search) return false;
  const headers = request.headers();
  if (headers.origin !== url.origin || (headers["sec-fetch-site"] && headers["sec-fetch-site"] !== "same-origin")
    || headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return false;
  const raw = request.postData();
  if (!raw || Buffer.byteLength(raw, "utf8") > 32_768) return false;
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return false; }
  if (!record(body) || Object.keys(body).length !== 2 || typeof body.scope !== "string"
    || body.scope.length < 1 || body.scope.length > 256 || !Array.isArray(body.receipts)
    || body.receipts.length < 1 || body.receipts.length > 32) return false;
  return body.receipts.every(receipt => record(receipt) && Object.keys(receipt).length === 2
    && typeof receipt.id === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(receipt.id)
    && typeof receipt.entryId === "string" && receipt.entryId.length > 0 && receipt.entryId.length <= 256);
}
