"use client";

import { useEffect, useMemo, useState } from "react";
import { encodeFilePathForApi, getRelativeFilePath } from "@/lib/file-paths";
import { hexPreview } from "@/lib/file-workbench";
import { formatSize } from "./file-viewer-utils";
import styles from "./BinaryViewer.module.css";

const MAX_PREVIEW = 64 * 1024;

export function BinaryViewer({ filePath, cwd }: { filePath: string; cwd?: string }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [size, setSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setBytes(null);
    setError(null);
    const encoded = encodeFilePathForApi(filePath);
    Promise.all([
      fetch(`/api/files/${encoded}?type=meta`, { signal: controller.signal }).then((response) => response.json()),
      fetch(`/api/files/${encoded}?type=raw`, { signal: controller.signal }).then((response) => response.arrayBuffer()),
    ]).then(([meta, buffer]: [{ size?: number }, ArrayBuffer]) => {
      setSize(typeof meta.size === "number" ? meta.size : buffer.byteLength);
      setBytes(new Uint8Array(buffer.slice(0, MAX_PREVIEW)));
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(String(reason));
    });
    return () => controller.abort();
  }, [filePath]);
  const rows = useMemo(() => bytes ? hexPreview(bytes) : [], [bytes]);
  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.path} title={filePath}>{getRelativeFilePath(filePath, cwd)}</span>
        <span>binary</span><span>{formatSize(size)}</span>
        <a className={styles.download} href={`/api/files/${encodeFilePathForApi(filePath)}?type=download`} download>Download</a>
      </div>
      {error ? <div className={styles.notice}>{error}</div> : !bytes ? <div className={styles.notice}>Loading…</div> : (
        <div className={styles.body}>
          {size > MAX_PREVIEW && <div className={styles.banner}>Showing the first {formatSize(MAX_PREVIEW)} of {formatSize(size)}</div>}
          <pre className={styles.hex}>{rows.join("\n")}</pre>
        </div>
      )}
    </div>
  );
}
