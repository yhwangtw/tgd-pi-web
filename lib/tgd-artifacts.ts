import { existsSync, readdirSync, statSync } from "fs";
import { join, dirname, basename, sep } from "path";

// ============================================================================
// tGD artifacts live in a SIBLING directory of the code repo — `$TGD_DIR`,
// which the tGD workflow resolves as env `$TGD_DIR` or `../<project>-tGD/`.
// Structure (authoritative, from the tGD repo's /tgd-* command specs):
//
//   <project>-tGD/                ← $TGD_DIR
//   ├── CONTEXT.md                ← /tgd-map
//   ├── TRACKING-PLAN.md          ← /tgd-plan
//   ├── CHANGELOG.md              ← /tgd-release
//   ├── REGRESSION-CATALOG.md     ← /tgd-release (when regression ACs exist)
//   ├── wiki/wiki.html            ← /tgd-map (infra)
//   ├── .scans/                   ← /tgd-map (infra — excluded)
//   └── <feature-name>/           ← a "feature" = dir with PRD.md or SPEC.md
//       ├── PRD.md  SPEC.md  DESIGN.md  TASKS.md
//       ├── TEST-REPORT.md  REVIEW.md  METRICS.md
//       └── prototype/*.html
// ============================================================================

/** Resolve the `$TGD_DIR` for a project cwd, or null if none exists. */
export function resolveTgdDir(cwd: string): string | null {
  const sibling = join(dirname(cwd), `${basename(cwd)}-tGD`);
  if (existsSync(sibling) && statSync(sibling).isDirectory()) return sibling;
  const env = process.env.TGD_DIR;
  if (env && existsSync(env) && statSync(env).isDirectory()) return env;
  return null;
}

export interface TgdArtifactFile {
  name: string;
  path: string;
}

export interface TgdFeature {
  name: string;
  path: string;
  docs: TgdArtifactFile[];
  prototypes: TgdArtifactFile[];
}

export interface TgdArtifacts {
  exists: boolean;
  tgdDir: string | null;
  /** top-level project docs (CONTEXT, tracking, release catalog, wiki) */
  top: TgdArtifactFile[];
  features: TgdFeature[];
}

const FEATURE_DOC_ORDER = [
  "PRD.md",
  "SPEC.md",
  "DESIGN.md",
  "TASKS.md",
  "TEST-REPORT.md",
  "REVIEW.md",
  "METRICS.md",
];
const PROTOTYPE_SCAN_MAX_DEPTH = 8;
const PROTOTYPE_SCAN_MAX_DIRS = 200;

function isFeatureDir(dir: string): boolean {
  return existsSync(join(dir, "PRD.md")) || existsSync(join(dir, "SPEC.md"));
}

function readPrototypeFiles(protoDir: string): TgdArtifactFile[] {
  const prototypes: TgdArtifactFile[] = [];
  const pending = [{ relativeDir: "", depth: 0 }];

  for (let index = 0; index < pending.length && index < PROTOTYPE_SCAN_MAX_DIRS; index++) {
    const { relativeDir, depth } = pending[index];
    let entries;
    try {
      entries = readdirSync(join(protoDir, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relativePath = join(relativeDir, entry.name);
      if (entry.isDirectory() && depth < PROTOTYPE_SCAN_MAX_DEPTH) {
        pending.push({ relativeDir: relativePath, depth: depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        prototypes.push({
          name: relativePath.split(sep).join("/"),
          path: join(protoDir, relativePath),
        });
      }
    }
  }

  return prototypes.sort((a, b) => a.name.localeCompare(b.name));
}

export function readTgdArtifacts(cwd: string): TgdArtifacts {
  const tgdDir = resolveTgdDir(cwd);
  if (!tgdDir) return { exists: false, tgdDir: null, top: [], features: [] };

  const top: TgdArtifactFile[] = [];
  for (const name of ["CONTEXT.md", "TRACKING-PLAN.md", "CHANGELOG.md", "REGRESSION-CATALOG.md"]) {
    if (existsSync(join(tgdDir, name))) top.push({ name, path: join(tgdDir, name) });
  }
  const wiki = join(tgdDir, "wiki", "wiki.html");
  if (existsSync(wiki)) top.push({ name: "wiki.html", path: wiki });

  const features: TgdFeature[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(tgdDir); } catch { /* ignore */ }
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;        // .scans, dot-dirs
    if (name === "wiki") continue;
    const dir = join(tgdDir, name);
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { /* ignore */ }
    if (!isDir || !isFeatureDir(dir)) continue;

    const docs: TgdArtifactFile[] = [];
    for (const doc of FEATURE_DOC_ORDER) {
      const p = join(dir, doc);
      if (existsSync(p)) {
        docs.push({ name: doc, path: p });
      }
    }
    const protoDir = join(dir, "prototype");
    const prototypes = existsSync(protoDir) ? readPrototypeFiles(protoDir) : [];
    features.push({ name, path: dir, docs, prototypes });
  }

  return { exists: true, tgdDir, top, features };
}
