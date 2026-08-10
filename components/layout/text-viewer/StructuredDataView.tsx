"use client";

import { useMemo, useState } from "react";
import { parseDelimitedText } from "@/lib/file-workbench";
import styles from "./StructuredDataView.module.css";

function JsonNode({ value, name, path, depth = 0 }: { value: unknown; name?: string; path: string; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  const compound = value !== null && typeof value === "object";
  const entries = compound ? Object.entries(value as Record<string, unknown>) : [];
  return (
    <div className={styles.node} style={{ "--depth": depth } as React.CSSProperties}>
      <div className={styles.nodeRow}>
        {compound ? <button className={styles.disclosure} onClick={() => setOpen((current) => !current)} aria-expanded={open}>{open ? "▾" : "▸"}</button> : <span className={styles.disclosureSpacer} />}
        {name != null && <button className={styles.key} title={`Copy ${path}`} onClick={() => navigator.clipboard?.writeText(path)}>{name}</button>}
        {name != null && <span className={styles.colon}>:</span>}
        {compound ? <span className={styles.summary}>{Array.isArray(value) ? `Array(${entries.length})` : `{${entries.length}}`}</span> : <span className={typeof value === "string" ? styles.string : typeof value === "number" ? styles.number : styles.literal}>{JSON.stringify(value)}</span>}
      </div>
      {compound && open && <div>{entries.map(([childName, child]) => <JsonNode key={childName} value={child} name={childName} path={Array.isArray(value) ? `${path}[${childName}]` : path ? `${path}.${childName}` : childName} depth={depth + 1} />)}</div>}
    </div>
  );
}

function parseLooseYaml(content: string): Array<{ key: string; value: string; level: number; line: number }> {
  const out: Array<{ key: string; value: string; level: number; line: number }> = [];
  content.split("\n").forEach((line, index) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const match = line.match(/^(\s*)(?:-\s*)?([^:#][^:]*):(?:\s*(.*))?$/);
    if (match) out.push({ key: match[2].trim(), value: (match[3] ?? "").trim(), level: Math.floor(match[1].length / 2), line: index + 1 });
  });
  return out;
}

export function StructuredDataView({ content, kind, onGotoLine }: { content: string; kind: "json" | "yaml" | "csv" | "tsv"; onGotoLine?: (line: number) => void }) {
  const [query, setQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const json = useMemo(() => {
    if (kind !== "json") return { value: null as unknown, error: "" };
    try {
      if (content.trim().startsWith("{") || content.trim().startsWith("[")) return { value: JSON.parse(content) as unknown, error: "" };
      return { value: content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown), error: "" };
    } catch (error) { return { value: null as unknown, error: error instanceof Error ? error.message : String(error) }; }
  }, [content, kind]);
  const yaml = useMemo(() => kind === "yaml" ? parseLooseYaml(content) : [], [content, kind]);
  const table = useMemo(() => kind === "csv" || kind === "tsv" ? parseDelimitedText(content, kind === "csv" ? "," : "\t") : [], [content, kind]);

  if (kind === "json") return json.error ? <div className={styles.error}>Cannot parse JSON: {json.error}</div> : <div className={styles.tree}><JsonNode value={json.value} path="$" /></div>;
  if (kind === "yaml") return (
    <div className={styles.yamlList}>{yaml.map((item) => (
      <button key={`${item.line}-${item.key}`} className={styles.yamlRow} style={{ paddingLeft: 14 + item.level * 18 }} onClick={() => onGotoLine?.(item.line)}>
        <span className={styles.yamlKey}>{item.key}</span>{item.value && <span className={styles.yamlValue}>{item.value}</span>}<span className={styles.lineNo}>L{item.line}</span>
      </button>
    ))}</div>
  );

  const header = table[0] ?? [];
  let body = table.slice(1);
  if (query.trim()) body = body.filter((row) => row.some((cell) => cell.toLowerCase().includes(query.trim().toLowerCase())));
  if (sortColumn != null) body = [...body].sort((a, b) => (a[sortColumn] ?? "").localeCompare(b[sortColumn] ?? "", undefined, { numeric: true }) * (sortAsc ? 1 : -1));
  return (
    <div className={styles.tableRoot}>
      <div className={styles.tableTools}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter rows…" /><span>{body.length} rows</span></div>
      <div className={styles.tableScroll}><table><thead><tr>{header.map((cell, column) => <th key={column}><button onClick={() => { if (sortColumn === column) setSortAsc((current) => !current); else { setSortColumn(column); setSortAsc(true); } }}>{cell || `Column ${column + 1}`}{sortColumn === column ? (sortAsc ? " ↑" : " ↓") : ""}</button></th>)}</tr></thead><tbody>{body.slice(0, 2_000).map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, column) => <td key={column}>{row[column] ?? ""}</td>)}</tr>)}</tbody></table></div>
    </div>
  );
}
