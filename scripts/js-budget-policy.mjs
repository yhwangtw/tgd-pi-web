// These are distinct measurements: rendered HTML script tags versus requests
// through the initial hydrated UI (including its asynchronous code highlighter).
// Keep separate defaults AND override keys so one scope cannot relax the other.
const budgets = {
  entry: {
    rawKiB: 1800,
    gzipKiB: 550,
    rawKey: "PIWEB_MAX_INITIAL_JS_KB",
    gzipKey: "PIWEB_MAX_INITIAL_JS_GZIP_KB",
  },
  hydrated: {
    rawKiB: 2100,
    gzipKiB: 675,
    rawKey: "PIWEB_MAX_HYDRATED_JS_KB",
    gzipKey: "PIWEB_MAX_HYDRATED_JS_GZIP_KB",
  },
};

export function javascriptBudget(scope, env = process.env) {
  const policy = Object.hasOwn(budgets, scope) ? budgets[scope] : null;
  if (!policy) throw new Error("Unknown JavaScript budget measurement scope.");
  const rawBytes = Number(env[policy.rawKey] ?? policy.rawKiB) * 1024;
  const gzipBytes = Number(env[policy.gzipKey] ?? policy.gzipKiB) * 1024;
  if (!Number.isFinite(rawBytes) || rawBytes <= 0 || !Number.isFinite(gzipBytes) || gzipBytes <= 0) {
    throw new Error("JavaScript budget values must be positive numbers.");
  }
  return { rawBytes, gzipBytes };
}
