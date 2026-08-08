import type { AgentSessionLike } from "./pi-types";

export interface ContextSourceEntry {
  kind: "agents" | "system" | "append";
  path: string;
  content: string;
  lines: number;
  characters: number;
}

export interface ContextResourceEntry {
  name: string;
  description?: string;
  path?: string;
  scope?: string;
  source?: string;
  enabled?: boolean;
}

export interface ContextReport {
  sessionId: string;
  cwd: string;
  model?: { provider: string; id: string };
  projectTrusted: boolean;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  effectiveSystemPrompt: string;
  sources: ContextSourceEntry[];
  skills: ContextResourceEntry[];
  prompts: ContextResourceEntry[];
  tools: ContextResourceEntry[];
  diagnostics: Array<{ type: string; message: string; path?: string }>;
}

function sourceEntry(kind: ContextSourceEntry["kind"], path: string, content: string): ContextSourceEntry {
  return {
    kind,
    path,
    content,
    lines: content ? content.split(/\r?\n/).length : 0,
    characters: content.length,
  };
}

export function buildContextReport(session: AgentSessionLike, cwdOverride?: string): ContextReport {
  const loader = session.resourceLoader;
  const skillsResult = loader?.getSkills();
  const promptsResult = loader?.getPrompts();
  const activeTools = new Set(session.getActiveToolNames());
  const basePrompt = loader?.getSystemPrompt();
  const baseSource = loader?.getSystemPromptSource();
  const appendPrompts = loader?.getAppendSystemPrompt() ?? [];
  const appendSources = loader?.getAppendSystemPromptSources() ?? [];
  const sources: ContextSourceEntry[] = [];

  for (const file of loader?.getAgentsFiles().agentsFiles ?? []) {
    sources.push(sourceEntry("agents", file.path, file.content));
  }
  if (basePrompt && baseSource) sources.push(sourceEntry("system", baseSource.path, basePrompt));
  appendPrompts.forEach((content, index) => {
    sources.push(sourceEntry("append", appendSources[index]?.path ?? `append-system-${index + 1}`, content));
  });

  const skillDiagnostics = skillsResult?.diagnostics ?? [];
  const promptDiagnostics = promptsResult?.diagnostics ?? [];
  return {
    sessionId: session.sessionId,
    cwd: cwdOverride ?? session.sessionManager.getCwd(),
    model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
    projectTrusted: session.settingsManager.isProjectTrusted(),
    contextUsage: session.getContextUsage() ?? null,
    effectiveSystemPrompt: session.agent.state?.systemPrompt ?? "",
    sources,
    skills: (skillsResult?.skills ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      scope: skill.sourceInfo.scope,
      source: skill.sourceInfo.source,
      enabled: !skill.disableModelInvocation,
    })),
    prompts: (promptsResult?.prompts ?? []).map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      path: prompt.filePath,
      scope: prompt.sourceInfo.scope,
      source: prompt.sourceInfo.source,
      enabled: true,
    })),
    tools: session.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      enabled: activeTools.has(tool.name),
    })),
    diagnostics: [...skillDiagnostics, ...promptDiagnostics].map((diagnostic) => ({
      type: diagnostic.type,
      message: diagnostic.message,
      path: diagnostic.path,
    })),
  };
}
