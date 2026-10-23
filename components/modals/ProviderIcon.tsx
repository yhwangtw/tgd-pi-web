"use client";


import { AnthropicIcon, OpenAIIcon, GoogleColorIcon, DeepSeekColorIcon, GroqIcon, MistralColorIcon, MoonshotIcon, MinimaxColorIcon, FireworksColorIcon, HuggingFaceColorIcon, CerebrasColorIcon, OpenRouterIcon, XAIIcon, CloudflareColorIcon, VercelIcon, GithubCopilotIcon, AwsColorIcon, AzureColorIcon, KimiColorIcon, QwenColorIcon, ZhipuColorIcon, CohereColorIcon, PerplexityColorIcon, TogetherColorIcon, GrokIcon, AntGroupColorIcon, NvidiaColorIcon, OpenCodeIcon, XiaomiMiMoIcon, ZAIIcon } from "./provider-icons";

import type { IconComponent } from "./models-config-types";

// hasColor=true → Color icon (self-colored SVG, no wrapper)
// hasColor=false → Mono icon (rendered with currentColor, inherits theme text color)
const PROVIDER_ICONS: Record<string, { Icon: IconComponent; hasColor: boolean }> = {
  "anthropic":              { Icon: AnthropicIcon,        hasColor: false },
  "openai":                 { Icon: OpenAIIcon,           hasColor: false },
  "openai-codex":           { Icon: OpenAIIcon,           hasColor: false },
  "google":                 { Icon: GoogleColorIcon,      hasColor: true },
  "google-vertex":          { Icon: GoogleColorIcon,      hasColor: true },
  "ant-ling":               { Icon: AntGroupColorIcon,    hasColor: true },
  "deepseek":               { Icon: DeepSeekColorIcon,    hasColor: true },
  "groq":                   { Icon: GroqIcon,             hasColor: false },
  "mistral":                { Icon: MistralColorIcon,     hasColor: true },
  "moonshotai":             { Icon: MoonshotIcon,         hasColor: false },
  "moonshotai-cn":          { Icon: MoonshotIcon,         hasColor: false },
  "moonshot":               { Icon: MoonshotIcon,         hasColor: false },
  "minimax":                { Icon: MinimaxColorIcon,     hasColor: true },
  "minimax-cn":             { Icon: MinimaxColorIcon,     hasColor: true },
  "fireworks":              { Icon: FireworksColorIcon,   hasColor: true },
  "huggingface":            { Icon: HuggingFaceColorIcon, hasColor: true },
  "cerebras":               { Icon: CerebrasColorIcon,    hasColor: true },
  "openrouter":             { Icon: OpenRouterIcon,       hasColor: false },
  "xai":                    { Icon: XAIIcon,              hasColor: false },
  "cloudflare-ai-gateway":  { Icon: CloudflareColorIcon,  hasColor: true },
  "cloudflare-workers-ai":  { Icon: CloudflareColorIcon,  hasColor: true },
  "vercel-ai-gateway":      { Icon: VercelIcon,           hasColor: false },
  "github-copilot":         { Icon: GithubCopilotIcon,    hasColor: false },
  "amazon-bedrock":         { Icon: AwsColorIcon,         hasColor: true },
  "azure-openai-responses": { Icon: AzureColorIcon,       hasColor: true },
  "kimi-coding":            { Icon: KimiColorIcon,        hasColor: true },
  "nvidia":                 { Icon: NvidiaColorIcon,      hasColor: true },
  "opencode":               { Icon: OpenCodeIcon,         hasColor: false },
  "opencode-go":            { Icon: OpenCodeIcon,         hasColor: false },
  "qwen":                   { Icon: QwenColorIcon,        hasColor: true },
  "xiaomi":                 { Icon: XiaomiMiMoIcon,       hasColor: false },
  "xiaomi-token-plan-ams":  { Icon: XiaomiMiMoIcon,       hasColor: false },
  "xiaomi-token-plan-cn":   { Icon: XiaomiMiMoIcon,       hasColor: false },
  "xiaomi-token-plan-sgp":  { Icon: XiaomiMiMoIcon,       hasColor: false },
  "zai":                    { Icon: ZAIIcon,              hasColor: false },
  "zai-coding-cn":          { Icon: ZAIIcon,              hasColor: false },
  "zhipu":                  { Icon: ZhipuColorIcon,       hasColor: true },
  "cohere":                 { Icon: CohereColorIcon,      hasColor: true },
  "perplexity":             { Icon: PerplexityColorIcon,  hasColor: true },
  "together":               { Icon: TogetherColorIcon,    hasColor: true },
  "grok":                   { Icon: GrokIcon,             hasColor: false },
};

export function ProviderIcon({ id, size }: { id: string; size: number }) {
  const pi = PROVIDER_ICONS[id];
  if (!pi) {
    const label = id
      .split(/[-_]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?";
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-control-compact)",
          color: "var(--text-dim)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: Math.max(10, Math.floor(size * 0.42)),
          fontWeight: "var(--weight-bold)",
          lineHeight: "var(--leading-none)",
        }}
      >
        {label}
      </span>
    );
  }
  // Color icons: self-colored SVG, no wrapper needed
  if (pi.hasColor) return <pi.Icon size={size} />;
  // Mono icons: use currentColor so they adapt to light/dark theme
  return <pi.Icon size={size} style={{ color: "var(--text-muted)" }} />;
}
