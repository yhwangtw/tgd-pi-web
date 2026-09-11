import { diffArrays } from "diff";

export type DiffLine = {
  type: "unchanged" | "removed" | "added";
  text: string;
  /** Old-document number for unchanged/removed; new-document number for added. */
  lineNo: number;
};

/** Bound expensive comparisons without ever dropping content from either document. */
export function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const changes = diffArrays(oldLines, newLines, { maxEditLength: 2048, timeout: 80 });
  if (!changes) {
    return [
      ...oldLines.map((text, i) => ({ type: "removed" as const, text, lineNo: i + 1 })),
      ...newLines.map((text, i) => ({ type: "added" as const, text, lineNo: i + 1 })),
    ];
  }
  let oldNo = 1;
  let newNo = 1;
  const result: DiffLine[] = [];
  for (const change of changes) {
    for (const text of change.value) {
      if (change.removed) result.push({ type: "removed", text, lineNo: oldNo++ });
      else if (change.added) result.push({ type: "added", text, lineNo: newNo++ });
      else {
        result.push({ type: "unchanged", text, lineNo: oldNo++ });
        newNo++;
      }
    }
  }
  return result;
}
