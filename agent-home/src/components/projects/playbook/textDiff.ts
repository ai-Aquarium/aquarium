/**
 * Paragraph-level diff of two playbook bodies, for the side-by-side
 * Compare view. A paragraph is one non-empty line (trimmed); two
 * paragraphs match only when their text is identical, so an edited
 * paragraph reads as removed on the left and added on the right.
 */

export type TextDiffKind = "same" | "removed" | "added";

export interface TextDiffRow {
  kind: TextDiffKind;
  text: string;
}

export interface TextDiff {
  /** The older text: `same` and `removed` rows, in its own order. */
  before: TextDiffRow[];
  /** The newer text: `same` and `added` rows, in its own order. */
  after: TextDiffRow[];
  added: number;
  removed: number;
  unchanged: boolean;
}

export function paragraphs(body: string | null | undefined): string[] {
  return (body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Longest common subsequence table, filled from the end. */
function lcsTable(a: string[], b: string[]): number[][] {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  return t;
}

export function textDiff(beforeBody: string | null | undefined, afterBody: string | null | undefined): TextDiff {
  const a = paragraphs(beforeBody);
  const b = paragraphs(afterBody);
  const t = lcsTable(a, b);
  const kept = new Set<number>();
  const keptB = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kept.add(i++);
      keptB.add(j++);
    } else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  const before = a.map((text, k): TextDiffRow => ({ kind: kept.has(k) ? "same" : "removed", text }));
  const after = b.map((text, k): TextDiffRow => ({ kind: keptB.has(k) ? "same" : "added", text }));
  const removed = before.length - kept.size;
  const added = after.length - keptB.size;
  return { before, after, added, removed, unchanged: added + removed === 0 };
}
