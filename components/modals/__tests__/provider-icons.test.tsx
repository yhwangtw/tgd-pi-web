import React from "react";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as icons from "../provider-icons";
import { ProviderIcon } from "../ProviderIcon";
import hashes from "@/vendor/lobe-icons/svg-hashes.json";
function normalize(markup: string) {
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  for (const [index, id] of ids.entries()) markup = markup.split(id).join("gradient-" + index);
  return markup;
}
describe("local provider SVGs", () => {
  it("preserves all 30 original SVG structures, titles, colors and gradients", () => {
    expect(Object.keys(icons)).toHaveLength(30);
    for (const [name, expected] of Object.entries(hashes)) {
      const Icon = icons[name as keyof typeof icons];
      const markup = renderToStaticMarkup(<Icon size={16} style={{ color: "#123456" }} />);
      expect(createHash("sha256").update(normalize(markup)).digest("hex"), name).toBe(expected);
    }
  });
  it("uses unique, resolvable gradient IDs for repeated icons", () => {
    const markup = renderToStaticMarkup(<><icons.AzureColorIcon /><icons.AzureColorIcon /><icons.QwenColorIcon /><icons.MinimaxColorIcon /><icons.AntGroupColorIcon /></>);
    const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    expect(ids.length).toBeGreaterThan(6);
    expect(new Set(ids).size).toBe(ids.length);
    for (const match of markup.matchAll(/url\(#([^)]*)\)/g)) expect(ids).toContain(match[1]);
  });
  it("retains every provider alias, theme colors, dimensions and unknown fallback", () => {
    const providers = ["anthropic","openai","openai-codex","google","google-vertex","ant-ling","deepseek","groq","mistral","moonshotai","moonshotai-cn","moonshot","minimax","minimax-cn","fireworks","huggingface","cerebras","openrouter","xai","cloudflare-ai-gateway","cloudflare-workers-ai","vercel-ai-gateway","github-copilot","amazon-bedrock","azure-openai-responses","kimi-coding","nvidia","opencode","opencode-go","qwen","xiaomi","xiaomi-token-plan-ams","xiaomi-token-plan-cn","xiaomi-token-plan-sgp","zai","zai-coding-cn","zhipu","cohere","perplexity","together","grok"];
    for (const id of providers) expect(renderToStaticMarkup(<ProviderIcon id={id} size={24} />), id).toContain('<svg');
    expect(renderToStaticMarkup(<ProviderIcon id="anthropic" size={24} />)).toContain('color:var(--text-muted)');
    expect(renderToStaticMarkup(<ProviderIcon id="google" size={24} />)).toContain('fill="#4285F4"');
    expect(renderToStaticMarkup(<ProviderIcon id="unknown-provider" size={24} />)).toContain('UP</span>');
  });
});
