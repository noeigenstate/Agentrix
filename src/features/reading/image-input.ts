const IMAGE = /\[Image #(\d+)\]/g;

export const inputImageLabels = (text: string) => [...text.matchAll(IMAGE)].map(match => match[0]);

// Claude 2.1.312's Mi cursor and Codex 0.165.0's TextArea treat an image as one element. Backspace removes its
// placeholder; only surviving image IDs are submitted. Claude keeps paste IDs; Codex renumbers its attachments.
export function imageRemoval(agent: 'claude' | 'codex', text: string, index: number, rows: number) {
  const matches = [...text.matchAll(IMAGE)], target = matches[index];
  if (!target) return null;
  // Words belong to the reader's textarea. Also tolerate native text before or after the chips: navigate from the
  // end with a chip-only suffix, or from the start with a chip-only prefix. Never guess offsets in wrapped prose.
  const fromEnd = !text.slice(target.index + target[0].length).replace(IMAGE, '').trim();
  if (!fromEnd && text.slice(0, target.index).replace(IMAGE, '').trim()) return null;
  // Ctrl+E advances logical lines in Codex; End advances visual lines in Claude. Together they reach the buffer's
  // end from any cursor position, including a wrapped or multiline draft. Word-left skips whitespace between chips.
  const end = '\x05\x1b[F'.repeat(rows + 1);
  const keys = (fromEnd ? end + '\x1b[1;5D'.repeat(matches.length - index) + '\x1b[C'
    : '\x01\x1b[H'.repeat(rows + 1) + '\x1b[1;5C'.repeat(index + 1)) + '\x7f' + end;
  const removed = Number(target[1]);
  const labels = matches.filter((_, at) => at !== index).map(match => agent === 'codex' && Number(match[1]) > removed ? `[Image #${Number(match[1]) - 1}]` : match[0]);
  return { keys, labels };
}
