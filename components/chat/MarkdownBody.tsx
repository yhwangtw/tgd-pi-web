"use client";

import type { Pluggable, PluggableList } from "unified";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
// PrismAsync keeps the full language set but splits refractor + languages into
// a lazily-loaded chunk, so the highlighter never blocks the initial bundle.
import { PrismAsync as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme } from "@/hooks/useTheme";
import { looksLikeFilePath, requestOpenFile } from "@/lib/file-links";
import { encodeFilePathForApi, normalizeFilePathSlashes } from "@/lib/file-paths";
import { useI18n } from "@/lib/i18n";
import { parseOutputSegments } from "@/lib/output-design";
import { FocusDialog } from "./FocusDialog";
import { StructuredOutputCard } from "./StructuredOutputCard";
import styles from "./MarkdownBody.module.css";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  /** Enable a constrained subset of raw HTML for trusted local file previews. */
  allowSafeHtml?: boolean;
  /** Absolute Markdown path used to resolve local relative image sources. */
  sourceFilePath?: string;
  /** Enhance Pi Web's small semantic blockquote subset into output cards. */
  structuredOutput?: boolean;
  /** Place turn evidence between explanatory prose and the first output card. */
  outputAccessory?: ReactNode;
}

type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const BLOCKED_PREVIEW_TAGS = new Set([
  "applet", "base", "button", "embed", "form", "frame", "frameset",
  "iframe", "input", "link", "meta", "object", "script", "select",
  "style", "textarea",
]);

/** Raw README HTML is useful for badges and alignment, but must stay inert. */
function rehypeSafeLocalHtml() {
  return (tree: HastNode) => {
    const clean = (node: HastNode): HastNode | null => {
      if (node.type === "element" && node.tagName) {
        if (BLOCKED_PREVIEW_TAGS.has(node.tagName.toLowerCase())) return null;
        if (node.properties) {
          for (const key of Object.keys(node.properties)) {
            if (/^on/i.test(key) || key === "style" || key === "srcDoc") {
              delete node.properties[key];
            }
          }
        }
      }
      if (node.children) {
        node.children = node.children.map(clean).filter((child): child is HastNode => child !== null);
      }
      return node;
    };
    clean(tree);
  };
}

export function resolveMarkdownImageSource(src: string | undefined, sourceFilePath?: string): string | undefined {
  if (!src || !sourceFilePath || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(src)) return src;

  const source = normalizeFilePathSlashes(sourceFilePath).split("/");
  source.pop();
  let relative = src.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  try { relative = decodeURIComponent(relative); } catch { /* keep malformed input literal */ }
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") source.pop();
    else source.push(part);
  }

  const absolute = source.join("/") || "/";
  return `/api/files/${encodeFilePathForApi(absolute)}?type=raw`;
}

type MathPlugins = {
  remarkMath: typeof import("remark-math").default;
  rehypeKatex: typeof import("rehype-katex").default;
};

/**
 * Heuristic: does this markdown contain LaTeX math?
 * - Block: $$...$$ on its own line
 * Inline single-dollar math is intentionally disabled. In a coding UI,
 * shell variables such as `$TGD_DIR` are far more common than inline LaTeX
 * and must remain literal text. Display math continues to use `$$...$$`.
 * If no math is present, we skip the (large) remark-math + rehype-katex bundle entirely.
 */
function containsMath(markdown: string): boolean {
  if (/^\s{0,3}\$\$.*\$\$\s*$/m.test(markdown)) return true;
  if (/\$\$[\s\S]+?\$\$/.test(markdown)) return true;
  return false;
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}

export function MarkdownBody({ children, className, isStreaming, allowSafeHtml = false, sourceFilePath, structuredOutput = false, outputAccessory }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  const needsMath = useMemo(() => containsMath(normalizedMarkdown), [normalizedMarkdown]);
  const outputSegments = useMemo(
    () => structuredOutput ? parseOutputSegments(normalizedMarkdown) : null,
    [normalizedMarkdown, structuredOutput],
  );
  const [mathPlugins, setMathPlugins] = useState<MathPlugins | null>(null);

  useEffect(() => {
    if (!needsMath) {
      setMathPlugins(null);
      return;
    }
    let cancelled = false;
    Promise.all([import("remark-math"), import("rehype-katex")])
      .then(([remarkMathMod, rehypeKatexMod]) => {
        if (cancelled) return;
        setMathPlugins({
          remarkMath: remarkMathMod.default,
          rehypeKatex: rehypeKatexMod.default,
        });
      })
      .catch(() => {
        // If plugin load fails, fall back to no math (better than crashing the message)
        if (!cancelled) setMathPlugins(null);
      });
    return () => {
      cancelled = true;
    };
  }, [needsMath]);

  const remarkPlugins: PluggableList = useMemo(
    () => (mathPlugins ? [remarkGfm, [mathPlugins.remarkMath, { singleDollarTextMath: false }]] : [remarkGfm]),
    [mathPlugins],
  );
  const rehypePlugins: PluggableList = useMemo(
    () => {
      const plugins: PluggableList = [];
      if (allowSafeHtml) {
        plugins.push(rehypeRaw as Pluggable, rehypeSafeLocalHtml as Pluggable);
      }
      if (mathPlugins) {
        plugins.push([mathPlugins.rehypeKatex, { throwOnError: false, strict: false }] as Pluggable);
      }
      return plugins;
    },
    [allowSafeHtml, mathPlugins],
  );

  if (outputSegments?.some((segment) => segment.type === "card")) {
    const firstCardIndex = outputSegments.findIndex((segment) => segment.type === "card");
    return (
      <div className={[styles.outputStack, styles.structuredStack, className].filter(Boolean).join(" ")}>
        {outputSegments.map((segment, index) => <div key={`output-${index}`} className={styles.outputSegment}>
          {outputAccessory && index === firstCardIndex && outputAccessory}
          {segment.type === "markdown" ? (
          <MarkdownRenderer
            markdown={segment.content}
            isStreaming={isStreaming}
            sourceFilePath={sourceFilePath}
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
          />
        ) : (
          <StructuredOutputCard
            kind={segment.kind}
            title={segment.title}
            detailsTitle={segment.detailsTitle}
            details={segment.details ? (
              <MarkdownRenderer
                markdown={segment.details}
                isStreaming={isStreaming}
                sourceFilePath={sourceFilePath}
                remarkPlugins={remarkPlugins}
                rehypePlugins={rehypePlugins}
              />
            ) : undefined}
          >
            <MarkdownRenderer
              markdown={segment.content}
              isStreaming={isStreaming}
              sourceFilePath={sourceFilePath}
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
            />
          </StructuredOutputCard>
          )}
        </div>)}
      </div>
    );
  }

  return (
    <div className={[styles.outputStack, className].filter(Boolean).join(" ")}>
      <MarkdownRenderer
        markdown={normalizedMarkdown}
        isStreaming={isStreaming}
        sourceFilePath={sourceFilePath}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
      />
      {outputAccessory}
    </div>
  );
}

function MarkdownRenderer({
  markdown,
  className,
  isStreaming,
  sourceFilePath,
  remarkPlugins,
  rehypePlugins,
}: {
  markdown: string;
  className?: string;
  isStreaming?: boolean;
  sourceFilePath?: string;
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
}) {
  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          code({ className, children, ...props }) {
            const lang = className?.replace("language-", "").toLowerCase() ?? "";
            const raw = String(children);
            const isBlock = className?.includes("language-") || raw.includes("\n");
            if (isBlock) {
              if (lang === "mermaid") {
                return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
              }
              return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} plain={isStreaming} />;
            }
            // File-path-looking inline code opens in the right-panel viewer.
            const link = looksLikeFilePath(raw);
            if (link) {
              return (
                <code
                  className={`${styles.inlineCode} ${styles.fileLink}`}
                  role="link"
                  tabIndex={0}
                  title={`Open ${link.path}`}
                  onClick={() => requestOpenFile(link)}
                  onKeyDown={(e) => { if (e.key === "Enter") requestOpenFile(link); }}
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className={styles.inlineCode}
                {...props}
              >
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
          // Wide tables scroll in their own wrapper instead of squishing the
          // column layout (or overflowing the bubble).
          table({ children, ...props }) {
            return (
              <div className="md-table-wrap">
                <table {...props}>{children}</table>
              </div>
            );
          },
          // External links open in a new tab (and get the ↗ marker via CSS).
          a({ href, children, ...props }) {
            const external = typeof href === "string" && /^https?:\/\//.test(href);
            return (
              <a
                href={href}
                {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                {...props}
              >
                {children}
              </a>
            );
          },
          img({ alt, ...props }) {
            const src = resolveMarkdownImageSource(typeof props.src === "string" ? props.src : undefined, sourceFilePath);
            // Arbitrary README badge hosts cannot be declared up front for next/image.
            // eslint-disable-next-line @next/next/no-img-element
            return <img {...props} src={src} alt={alt ?? ""} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function normalizeDisplayMath(markdown: string): string {
  const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  let fence: { marker: string; size: number } | null = null;

  return lines
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        const size = fenceMatch[1].length;
        if (!fence) fence = { marker, size };
        else if (marker === fence.marker && size >= fence.size) fence = null;
        return line;
      }

      if (fence) return line;

      const displayMathMatch = line.match(/^([ \t]{0,3})\$\$(.+)\$\$[ \t]*$/);
      if (!displayMathMatch) return line;

      const math = displayMathMatch[2].trim();
      if (!math) return line;

      return `${displayMathMatch[1]}$$${lineBreak}${math}${lineBreak}${displayMathMatch[1]}$$`;
    })
    .join(lineBreak);
}

function MermaidBlock({ code, isStreaming }: { code: string; isStreaming?: boolean }) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [renderedKey, setRenderedKey] = useState("");
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const currentKey = `${isDark ? "dark" : "light"}\n${code}`;

  useEffect(() => {
    if (!showPreview || isStreaming) return;

    let cancelled = false;
    setFailedKey(null);

    const render = async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: isDark ? "dark" : "default",
      });

      const parsed = await mermaid.parse(code, { suppressErrors: true });
      if (!parsed) throw new Error("Invalid Mermaid diagram");

      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `mermaid-${crypto.randomUUID()}`
          : `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await mermaid.render(id, code);
      if (!cancelled) {
        setSvg(result.svg);
        setRenderedKey(currentKey);
      }
    };

    render().catch(() => {
      if (!cancelled) setFailedKey(currentKey);
    });

    return () => {
      cancelled = true;
    };
  }, [code, currentKey, isDark, isStreaming, showPreview]);

  const previewBtnClass = [
    styles.previewBtn,
    showPreview ? styles.previewBtnActive : "",
    isStreaming ? styles.previewBtnStreaming : "",
  ].filter(Boolean).join(" ");

  const previewButton = (
    <button
      onClick={() => setShowPreview((v) => !v)}
      disabled={isStreaming}
      title={isStreaming ? t("code.previewAfterStream") : (showPreview ? t("code.showDiagramSource") : t("code.previewDiagram"))}
      className={previewBtnClass}
    >
      {showPreview ? t("code.source") : t("code.preview")}
    </button>
  );

  if (!showPreview || isStreaming) {
    return <CodeBlock code={code} lang="mermaid" headerAction={previewButton} />;
  }

  const body =
    failedKey === currentKey ? (
      <div className="mermaid-block mermaid-block-error">{t("code.invalidDiagram")}</div>
    ) : !svg || renderedKey !== currentKey ? (
      <div className="mermaid-block mermaid-block-loading" aria-label={t("code.renderingDiagram")} />
    ) : (
      <div
        className="mermaid-block"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );

  return (
    <div className={styles.blockContainer}>
      <div className={styles.blockHeader}>
        <span>mermaid</span>
        {previewButton}
      </div>
      {body}
    </div>
  );
}

function CodeBlock({ code, lang, headerAction, plain }: { code: string; lang: string; headerAction?: ReactNode; plain?: boolean }) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [focusWrap, setFocusWrap] = useState(false);
  const [focusLine, setFocusLine] = useState(1);
  const focusCodeRef = useRef<HTMLDivElement>(null);

  const copy = () => {
    copyText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!focusOpen) return;
    focusCodeRef.current?.querySelector<HTMLElement>(`[data-line="${focusLine}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [focusLine, focusOpen]);

  return (
    <div className={styles.blockContainer}>
      <div className={styles.blockHeader}>
        <span>{lang}</span>
        <div className={styles.headerActions}>
          {headerAction}
          <button
            type="button"
            onClick={() => setFocusOpen(true)}
            className={styles.focusBtn}
            title={t("code.focus")}
            aria-label={t("code.focus")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 3H3v5M16 21h5v-5M3 8l5-5M21 16l-5 5" />
            </svg>
          </button>
          <button
            onClick={copy}
            className={styles.copyBtn}
            aria-label={copied ? t("common.copied") : t("common.copy")}
          >
            {copied ? t("common.copied") : t("common.copy")}
          </button>
        </div>
      </div>
      {plain ? (
        // Streaming: Prism re-tokenizes the whole growing block on every
        // chunk — render plain until the message completes, then highlight
        // once. Same pattern as Mermaid.
        <pre className={styles.plainStreamPre}><code>{code}</code></pre>
      ) : (
      <SyntaxHighlighter
        language={lang || "text"}
        style={isDark ? vscDarkPlus : vs}
        showLineNumbers
        lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
        customStyle={{
          margin: 0,
          padding: "10px 12px",
          fontSize: "var(--text-md)",
          lineHeight: "var(--leading-relaxed)",
          borderRadius: 0,
          // Both forms: the highlighter themes mix `background` (vscDarkPlus)
          // and `backgroundColor` (vs); pinning both keeps the merged style
          // stable across theme switches (React warns when one form is
          // removed while the other is set).
          background: "var(--bg)",
          backgroundColor: "var(--bg)",
        }}
        codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
      >
        {code}
      </SyntaxHighlighter>
      )}
      <FocusDialog
        open={focusOpen}
        title={lang || t("code.plainText")}
        onClose={() => setFocusOpen(false)}
        wrap={focusWrap}
        onWrapChange={setFocusWrap}
        actions={(
          <>
            <label className={styles.lineJump}>
              <span>{t("code.line")}</span>
              <input
                type="number"
                min={1}
                max={Math.max(1, code.split("\n").length)}
                value={focusLine}
                onChange={(event) => setFocusLine(Math.max(1, Math.min(code.split("\n").length, Number(event.target.value) || 1)))}
              />
            </label>
            <button type="button" onClick={copy}>{copied ? t("common.copied") : t("common.copy")}</button>
          </>
        )}
      >
        <div ref={focusCodeRef} className={`${styles.focusCode} ${focusWrap ? styles.focusCodeWrap : ""}`}>
          {code.split("\n").map((line, index) => (
            <div key={index} data-line={index + 1} className={`${styles.focusCodeLine} ${focusLine === index + 1 ? styles.focusCodeLineActive : ""}`}>
              <button type="button" className={styles.focusLineNumber} onClick={() => setFocusLine(index + 1)} aria-label={`${t("code.line")} ${index + 1}`}>{index + 1}</button>
              <code>{line || " "}</code>
            </div>
          ))}
        </div>
      </FocusDialog>
    </div>
  );
}
