export type DiffLine = { kind: 'ctx' | 'add' | 'del' | 'gap'; text: string };

// A line diff (longest common subsequence) from one text to another, keeping `context` unchanged lines around each change.
export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n');
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  const lines: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: 'ctx', text: a[i] }); i++; j++; }
    else if (i < a.length && (j === b.length || common[i + 1][j] >= common[i][j + 1])) lines.push({ kind: 'del', text: a[i++] });
    else lines.push({ kind: 'add', text: b[j++] });
  }
  const changed = lines.flatMap((line, at) => line.kind === 'ctx' ? [] : [at]);
  const shown = (at: number) => changed.some(other => Math.abs(at - other) <= context);
  // One gap marker stands for each run of hidden unchanged lines.
  return lines.flatMap((line, at) => shown(at) ? [line] : at === 0 || shown(at - 1) ? [{ kind: 'gap' as const, text: '' }] : []);
}
