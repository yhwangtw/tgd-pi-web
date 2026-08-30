"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, FileCode2, FileStack, FileText, RefreshCw } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { encodeFilePathForApi, joinFilePath } from "@/lib/file-paths";
import { useI18n } from "@/lib/i18n";
import s from "./TgdArtifactsPanel.module.css";

interface ArtifactFile {
  name: string;
  path: string;
  phase?: string;
}
interface Feature {
  name: string;
  path: string;
  docs: ArtifactFile[];
  prototypes: ArtifactFile[];
  phasesDone: string[];
}
interface Artifacts {
  exists: boolean;
  tgdDir: string | null;
  top: ArtifactFile[];
  features: Feature[];
}

interface Props {
  cwd: string | null;
  refreshKey?: number;
  onOpenFile: (filePath: string, fileName: string) => void;
}

// The 7 phases in order, with which artifact-derived evidence marks them done.
const PHASES = ["map", "define", "plan", "develop", "verify", "review", "release"] as const;
function fileIcon(name: string) {
  return name.endsWith(".html")
    ? <FileCode2 size={14} strokeWidth={1.8} aria-hidden="true" />
    : <FileText size={14} strokeWidth={1.8} aria-hidden="true" />;
}

// ── Full-tree view: browse the ENTIRE tGD dir (nothing hidden — .scans,
// wiki/docs, prototypes, everything), lazily via the file-list endpoint. ──
interface DirEntry { name: string; isDir: boolean; size: number; }

async function listDir(abs: string): Promise<DirEntry[]> {
  try {
    const res = await fetch(`/api/files/${encodeFilePathForApi(abs)}?type=list`);
    if (!res.ok) return [];
    const d = await res.json() as { entries?: DirEntry[] };
    return d.entries ?? [];
  } catch {
    return [];
  }
}

function TreeNode({
  name, abs, isDir, depth, onOpenFile,
}: { name: string; abs: string; isDir: boolean; depth: number; onOpenFile: Props["onOpenFile"] }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const pad = 8 + depth * 13;

  useEffect(() => {
    if (isDir && open && children === null) listDir(abs).then(setChildren);
  }, [isDir, open, abs, children]);

  if (!isDir) {
    return (
      <button type="button" onClick={() => onOpenFile(abs, name)} className={s.fileRow} style={{ paddingLeft: pad }} title={abs}>
        <span className={s.fileIcon}>{fileIcon(name)}</span>
        <span className={s.fileName}>{name}</span>
      </button>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setOpen((o) => !o)} className={s.dirRow} style={{ paddingLeft: pad }} title={abs} aria-expanded={open}>
        <ChevronRight className={s.treeChevron} data-open={open || undefined} size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className={s.dirName}>{name}</span>
      </button>
      {open && children?.map((c) => (
        <TreeNode key={c.name} name={c.name} abs={joinFilePath(abs, c.name)} isDir={c.isDir} depth={depth + 1} onOpenFile={onOpenFile} />
      ))}
    </>
  );
}

function FileTree({ root, onOpenFile }: { root: string; onOpenFile: Props["onOpenFile"] }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  useEffect(() => { let live = true; listDir(root).then((e) => { if (live) setEntries(e); }); return () => { live = false; }; }, [root]);
  if (entries === null) return <div className={s.treeLoading}>{t("common.loading")}</div>;
  if (entries.length === 0) return <div className={s.noFeatures}>{t("tgd.emptyDirectory")}</div>;
  return (
    <div className={s.tree}>
      {entries.map((e) => (
        <TreeNode key={e.name} name={e.name} abs={joinFilePath(root, e.name)} isDir={e.isDir} depth={0} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

/**
 * tGD artifacts view — curated Map through Release lifecycle documents and
 * prototypes written into the sibling `<project>-tGD/` directory.
 * Two views: "Artifacts" (curated per-feature/phase) and "Files" (the whole
 * tGD dir as a tree, nothing hidden). Clicking a file opens it in the right
 * panel (markdown / HTML preview).
 */
export function TgdArtifactsPanel({ cwd, refreshKey, onOpenFile }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<Artifacts | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<"artifacts" | "files">("artifacts");
  useEffect(() => { setView((localStorage.getItem("pi-tgd-artifacts-view") as "artifacts" | "files") ?? "artifacts"); }, []);
  const pickView = useCallback((v: "artifacts" | "files") => { setView(v); localStorage.setItem("pi-tgd-artifacts-view", v); }, []);

  const load = useCallback(async () => {
    if (!cwd) { setData(null); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/tgd/artifacts?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as Artifacts);
    } catch {
      setData({ exists: false, tgdDir: null, top: [], features: [] });
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (!cwd) return <div className={s.empty}>{t("tgd.selectProject")}</div>;

  const fileRow = (f: ArtifactFile) => (
    <button type="button" key={f.path} onClick={() => onOpenFile(f.path, f.name)} className={s.fileRow} title={f.path}>
      <span className={s.fileIcon}>{fileIcon(f.name)}</span>
      <span className={s.fileName}>{f.name}</span>
    </button>
  );

  return (
    <div className={s.container}>
      <div className={`${s.header} chrome-mono`}>
        <span className={s.brand}>tGD</span>
        <div className={s.viewToggle} role="tablist">
          <button type="button" role="tab" aria-selected={view === "artifacts"} onClick={() => pickView("artifacts")} className={view === "artifacts" ? s.viewTabActive : s.viewTab}>{t("tgd.viewArtifacts")}</button>
          <button type="button" role="tab" aria-selected={view === "files"} onClick={() => pickView("files")} className={view === "files" ? s.viewTabActive : s.viewTab}>{t("tgd.viewFiles")}</button>
        </div>
        <IconButton
          label={t("common.refresh")}
          icon={<RefreshCw strokeWidth={1.8} className={loading ? s.spinning : undefined} />}
          size="compact"
          onClick={load}
          disabled={loading}
          className={s.refresh}
        />
      </div>

      {!data || !data.exists ? (
        <div className={s.empty}>
          <FileStack size={24} strokeWidth={1.6} aria-hidden="true" />
          <span>{t("tgd.emptyArtifacts")}</span>
          <span className={s.emptyHint}>{t("tgd.run")} <code>/tgd-map</code> {t("tgd.then")} <code>/tgd-define</code> {t("tgd.produceHint")}</span>
        </div>
      ) : view === "files" && data.tgdDir ? (
        <div className={s.body}>
          <FileTree key={data.tgdDir + (refreshKey ?? 0)} root={data.tgdDir} onOpenFile={onOpenFile} />
        </div>
      ) : (
        <div className={s.body}>
          {data.top.length > 0 && (
            <div className={s.section}>
              <div className={s.sectionTitle}>{t("tgd.project")}</div>
              {data.top.map(fileRow)}
            </div>
          )}

          {data.features.map((feat) => (
            <div key={feat.path} className={s.feature}>
              <div className={s.featureHead}>
                <span className={s.featureName} title={feat.name}>{feat.name}</span>
              </div>
              {/* phase correspondence — which phases this feature has evidence for */}
              <div className={s.phases}>
                {PHASES.map((p) => {
                  const done = feat.phasesDone.includes(p);
                  const label = t(`phase.label.${p}` as "phase.label.map" | "phase.label.define" | "phase.label.plan" | "phase.label.develop" | "phase.label.verify" | "phase.label.review" | "phase.label.release");
                  return (
                    <span key={p} className={`${s.phaseChip} ${done ? s.phaseDone : s.phaseTodo}`} title={done ? `${label} — ${t("tgd.hasArtifacts")}` : label}>
                      {label}
                    </span>
                  );
                })}
              </div>
              {feat.docs.map(fileRow)}
              {feat.prototypes.length > 0 && (
                <div className={s.protoGroup}>
                  <span className={s.protoLabel}>prototype</span>
                  {feat.prototypes.map(fileRow)}
                </div>
              )}
            </div>
          ))}

          {data.features.length === 0 && data.top.length > 0 && (
            <div className={s.noFeatures}>{t("tgd.noFeatureSpecs")} <code>/tgd-define</code>.</div>
          )}
        </div>
      )}
    </div>
  );
}
