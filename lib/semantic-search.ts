export type SemanticSource = "session" | "artifact" | "code";

export interface SemanticDocument {
  id: string;
  source: SemanticSource;
  title: string;
  text: string;
  path?: string;
  sessionId?: string;
  line?: number;
  modified?: string;
}

export interface SemanticHit extends Omit<SemanticDocument, "text"> {
  score: number;
  snippet: string;
}

const CONCEPTS: Record<string, string[]> = {
  error: ["fail", "failed", "failure", "exception", "錯誤", "失敗"],
  auth: ["login", "credential", "token", "oauth", "授權", "登入", "憑證"],
  deploy: ["release", "production", "publish", "部署", "發布", "上線"],
  test: ["verify", "validation", "spec", "測試", "驗證"],
  mobile: ["responsive", "rwd", "phone", "手機", "行動版"],
  schedule: ["cron", "timer", "scheduled", "排程", "定時"],
  message: ["chat", "conversation", "reply", "訊息", "對話", "回覆"],
};

function normalize(value: string): string[] {
  const lower = value.toLocaleLowerCase();
  const base = lower.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const tokens = new Set(base);
  for (const [concept, variants] of Object.entries(CONCEPTS)) {
    if (lower.includes(concept) || variants.some((variant) => lower.includes(variant))) {
      tokens.add(concept);
      variants.forEach((variant) => tokens.add(variant));
    }
  }
  return [...tokens];
}

function snippet(text: string, tokens: string[]): string {
  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLocaleLowerCase();
  const first = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 90);
  const value = flat.slice(start, start + 280).trim();
  return `${start > 0 ? "…" : ""}${value}${start + 280 < flat.length ? "…" : ""}`;
}

/** Local hybrid ranking: concept expansion + field boosts + BM25-like saturation. */
export function rankSemanticDocuments(query: string, documents: SemanticDocument[], limit = 50): SemanticHit[] {
  const queryTokens = normalize(query);
  if (queryTokens.length === 0) return [];
  return documents.flatMap((document) => {
    const titleTokens = new Set(normalize(document.title));
    const textTokens = normalize(document.text);
    const frequencies = new Map<string, number>();
    for (const token of textTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      if (titleTokens.has(token)) score += 5;
      const frequency = frequencies.get(token) ?? 0;
      if (frequency) score += 1 + Math.min(3, Math.log2(frequency + 1));
      if (document.path?.toLocaleLowerCase().includes(token)) score += 2;
    }
    if (`${document.title}\n${document.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) score += 7;
    if (score <= 0) return [];
    const { text: _text, ...rest } = document;
    return [{ ...rest, score: Math.round(score * 100) / 100, snippet: snippet(document.text, queryTokens) }];
  }).sort((a, b) => b.score - a.score || (b.modified ?? "").localeCompare(a.modified ?? "")).slice(0, limit);
}
