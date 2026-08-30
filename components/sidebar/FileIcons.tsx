import {
  Braces,
  Container,
  File,
  FileCode2,
  FileCog,
  FileJson2,
  FileKey2,
  FileLock2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

interface IconProps {
  size?: number;
}

const DIM = "var(--text-dim)";

function FileGlyph({ icon: Icon, size = 14 }: IconProps & { icon: LucideIcon }) {
  return <Icon size={size} strokeWidth={1.7} color={DIM} aria-hidden="true" />;
}

export function FolderIcon({ size = 14, open = false }: IconProps & { open?: boolean }) {
  return <FileGlyph icon={open ? FolderOpen : Folder} size={size} />;
}

export function GenericFileIcon({ size = 14 }: IconProps) {
  return <FileGlyph icon={File} size={size} />;
}

export function TypeScriptIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCode2} size={size} />; }
export function TypeScriptReactIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCode2} size={size} />; }
export function JavaScriptIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCode2} size={size} />; }
export function JavaScriptReactIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCode2} size={size} />; }
export function PythonIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCode2} size={size} />; }
export function JsonIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileJson2} size={size} />; }
export function CssIcon({ size = 14 }: IconProps) { return <FileGlyph icon={Braces} size={size} />; }
export function ScssIcon({ size = 14 }: IconProps) { return <FileGlyph icon={Braces} size={size} />; }
export function HtmlIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCode2} size={size} />; }
export function MarkdownIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileText} size={size} />; }
export function YamlIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCog} size={size} />; }
export function TomlIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCog} size={size} />; }
export function ShellIcon({ size = 14 }: IconProps) { return <FileGlyph icon={SquareTerminal} size={size} />; }
export function RustIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCode2} size={size} />; }
export function GoIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCode2} size={size} />; }
export function SqlIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCode2} size={size} />; }
export function GraphqlIcon({ size = 14 }: IconProps) { return <FileGlyph icon={Braces} size={size} />; }
export function TerraformIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCode2} size={size} />; }
export function DockerfileIcon({ size = 14 }: IconProps) { return <FileGlyph icon={Container} size={size} />; }
export function EnvIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileKey2} size={size} />; }
export function GitIcon({ size = 14 }: IconProps) { return <FileGlyph icon={GitBranch} size={size} />; }
export function LockFileIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileLock2} size={size} />; }
export function DocFileIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileText} size={size} />; }
export function PdfFileIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileText} size={size} />; }
export function ConfigIcon({ size = 14 }: IconProps) { return <FileGlyph icon={FileCog} size={size} />; }

export function getFileIcon(name: string, size = 14): React.ReactNode {
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";

  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return <DockerfileIcon size={size} />;
  if (lower === ".env" || lower.startsWith(".env.")) return <EnvIcon size={size} />;
  if (lower === ".gitignore" || lower === ".gitattributes" || lower === ".gitmodules") return <GitIcon size={size} />;
  if (lower === "package-lock.json" || lower === "yarn.lock" || lower === "bun.lock" || lower === "pnpm-lock.yaml" || lower === "cargo.lock") return <LockFileIcon size={size} />;
  if (lower.endsWith(".config.ts") || lower.endsWith(".config.js") || lower.endsWith(".config.mjs") || lower.endsWith(".config.cjs")) return <ConfigIcon size={size} />;
  if ([".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml", "eslint.config.mjs", "eslint.config.js"].includes(lower)) return <ConfigIcon size={size} />;

  switch (ext) {
    case "ts": return <TypeScriptIcon size={size} />;
    case "tsx": return <TypeScriptReactIcon size={size} />;
    case "js":
    case "mjs":
    case "cjs": return <JavaScriptIcon size={size} />;
    case "jsx": return <JavaScriptReactIcon size={size} />;
    case "py": return <PythonIcon size={size} />;
    case "json":
    case "jsonl": return <JsonIcon size={size} />;
    case "css":
    case "less": return <CssIcon size={size} />;
    case "scss": return <ScssIcon size={size} />;
    case "html":
    case "htm": return <HtmlIcon size={size} />;
    case "md":
    case "mdx": return <MarkdownIcon size={size} />;
    case "yaml":
    case "yml": return <YamlIcon size={size} />;
    case "toml": return <TomlIcon size={size} />;
    case "sh":
    case "bash":
    case "zsh":
    case "fish": return <ShellIcon size={size} />;
    case "rs": return <RustIcon size={size} />;
    case "go": return <GoIcon size={size} />;
    case "sql": return <SqlIcon size={size} />;
    case "graphql":
    case "gql": return <GraphqlIcon size={size} />;
    case "tf":
    case "hcl": return <TerraformIcon size={size} />;
    case "docx": return <DocFileIcon size={size} />;
    case "pdf": return <PdfFileIcon size={size} />;
    case "lock": return <LockFileIcon size={size} />;
    default: return <GenericFileIcon size={size} />;
  }
}
