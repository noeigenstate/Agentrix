import type { ScreenAgent, ScreenChoice, ScreenOption, ScreenQuestion } from './agent-screen-types.ts';

// Questions an agent asks with options, read from the text it drew (see tests/fixtures/screens/*-question*.txt).
// Only a question still waiting is recognised: its key hint (or Claude's review options) must close the screen.
// Codex MCP Field n/m forms deliberately stay waiting this round; their controls are not request_user_input's notes.
const option = /^(\s*)([❯›>]?)(\s*)(\d+)\.\s+(.+)$/;
const rule = (row: string) => /^\s*[─╌]{8,}\s*$/.test(row);
const lastContent = (rows: string[]) => { let end = rows.length - 1; while (end >= 0 && !rows[end].trim()) end--; return end; };

type Draft = ScreenOption & { column: number };
const selectedCursor = (mark: string | undefined, cursor: string) => mark === cursor || cursor === '❯' && mark === '>';
function draftOption(match: RegExpExecArray, role: ScreenOption['role'], cursor: string): Draft {
  return { number: Number(match[4]), label: match[5].trim(), detail: '', hotkey: null, selected: selectedCursor(match[2], cursor), role, column: match[1].length + match[2].length + match[3].length };
}
const finish = ({ column, ...rest }: Draft): ScreenOption => rest;
// The live option block: the row with the CLI's cursor (or Claude's selected Submit row), then back to its option 1.
// Numbered lines in the question's own text are above that and stay part of the question.
function optionStart(rows: string[], head: number, end: number, cursor: string): number {
  let selected = end;
  while (selected > head && !selectedCursor(option.exec(rows[selected])?.[2], cursor) && !(cursor === '❯' && /^\s*[❯>]\s*Submit$/.test(rows[selected]))) selected--;
  for (let index = selected; index > head; index--) if (Number(option.exec(rows[index])?.[4]) === 1) return index;
  return -1;
}
const question = (agent: ScreenAgent, fields: Partial<ScreenQuestion>): ScreenQuestion =>
  ({ agent, tabs: [], position: null, multi: false, submit: null, notes: null, review: null, ...fields });

// Claude 2.1.314's bundled symbols: checkboxOff/On are ☐/☒ or [ ]/[×]; tick is ✔ or √.
const tabRow = /^(?:←\s+)?(?:☐|☒|\[[ ×]\])\s+\S/;
const tabLabel = /^(☐|☒|\[[ ×]\]|[✔√])\s+(.+)$/;
const reviewWarning = /^(?:⚠\uFE0F?|‼)\s+You have not answered all questions[.!]?$/;

// Claude Code's AskUserQuestion: a tab row ("←  ☐ 回收站  ☒ 清理目录  ✔ Submit  →", or just "☐ 回收站"), the question,
// numbered options with their description on the next row, "Type something." for an own answer (it becomes the
// typed text, ticked), a "Submit" row under multi-select options, a rule, "Chat about this" and the key hint. After
// the last tab comes "Review your answers" with Submit answers / Cancel.
function claudeQuestion(rows: string[]): ScreenChoice | null {
  const end = lastContent(rows);
  let head = end;
  while (head >= 0 && !tabRow.test(rows[head].trim())) head--;
  // A clipped tab bar is recoverable only while the complete AskUserQuestion option block and closing hint remain.
  if (head < 0 && (!/^Enter to select\b/i.test(rows[end]?.trim() ?? '') ||
      !rows.some(row => /^\s*\d+\.\s+Chat about this$/.test(row)))) return null;
  const tabs = (rows[head] ?? '').trim().replace(/^←\s+/, '').replace(/\s+→$/, '').split(/\s{2,}/)
    .map(tab => tabLabel.exec(tab)).filter((tab): tab is RegExpExecArray => !!tab && !/[✔√]/.test(tab[1]))
    .map(tab => ({ label: tab[2].trim(), answered: tab[1] === '☒' || tab[1] === '[×]' }));
  const shownTabs = tabs.length > 1 ? tabs : [];

  let first = head + 1;
  while (first <= end && !rows[first].trim()) first++;
  if (rows[first]?.trim() === 'Review your answers') {
    const review: { question: string; answer: string }[] = [];
    const context: string[] = [];
    let index = first + 1;
    let part: 'question' | 'answer' = 'question';
    for (; index <= end; index++) {
      const text = rows[index].trim();
      if (!text) continue;
      if (reviewWarning.test(text)) context.push(text);
      else if (text === 'Ready to submit your answers?') break;
      else if (text.startsWith('●')) { review.push({ question: text.slice(1).trim(), answer: '' }); part = 'question'; }
      else if (text.startsWith('→') && review.length) { review[review.length - 1].answer = text.slice(1).trim(); part = 'answer'; }
      else if (review.length && /^\s+\S/.test(rows[index])) review[review.length - 1][part] += ' ' + text;
      else if (text) break;
    }
    const title = rows[index]?.trim() ?? '';
    const options: ScreenOption[] = [];
    for (index++; index <= end; index++) {
      const match = option.exec(rows[index]), text = rows[index].trim();
      if (match) options.push(finish(draftOption(match, 'answer', '❯')));
      else if (text && !/^Enter to/i.test(text)) return null;
    }
    if (title !== 'Ready to submit your answers?' || options.length !== 2 ||
        options[0].label !== 'Submit answers' || options[1].label !== 'Cancel' || !options.some(item => item.selected)) return null;
    return { kind: 'question', title, context, options, hint: null, question: question('claude', { tabs: shownTabs, review }) };
  }

  let index = optionStart(rows, head, end, '❯');
  if (index < 0) return null;
  // A missing tab bar cannot turn the conversation above option 1 into the question.
  if (head < 0 && rows.slice(0, index).some(row => rule(row) || /^\s*(?:[⏺●⎿]|[❯›>](?:\s|$))/.test(row))) return null;
  const title = rows.slice(head + 1, index).map(row => row.trim()).filter(Boolean);
  const options: Draft[] = [];
  let submit: ScreenQuestion['submit'] = null, hint: string | null = null, underRule = false, multi = false;
  for (; index <= end; index++) {
    const row = rows[index], text = row.trim(), match = option.exec(row);
    if (!text) continue;
    if (rule(row)) { underRule = true; continue; }
    if (/^Enter to select\b/i.test(text)) { hint = text; if (index !== end) return null; break; }
    const submitRow = /^([❯>]?)\s*Submit$/.exec(text);
    if (submitRow && !underRule) { submit = { selected: selectedCursor(submitRow[1], '❯') }; continue; }
    if (match) {
      const draft = draftOption(match, underRule ? 'chat' : 'answer', '❯');
      const box = /^\[([ ✔√✓×xX])\]\s*(.*)$/.exec(draft.label);
      if (box && !underRule) { multi = true; draft.checked = box[1] !== ' '; draft.label = box[2].trim(); }
      options.push(draft);
      continue;
    }
    const last = options[options.length - 1];
    if (last && row.search(/\S/) > last.column) { last.detail = last.detail ? `${last.detail} ${text}` : text; continue; }
    return null;
  }
  if (!hint || !title.length) return null;
  const answers = options.filter(item => item.role === 'answer');
  if (!answers.length) return null;
  // The last option above the rule takes an own answer ("Type something.").
  answers[answers.length - 1].role = 'input';
  return {
    kind: 'question', title: title.join(' '), context: [], options: options.map(finish), hint,
    question: question('claude', { tabs: shownTabs, multi, submit: multi ? submit ?? { selected: false } : null }),
  };
}

// Codex's request_user_input (Plan mode): "Question 1/2 (2 unanswered)", the question, numbered options with their
// description in a second column, "None of the above", an optional notes row ("› Add notes" after Tab) and the hint.
function codexQuestion(rows: string[]): ScreenChoice | null {
  const end = lastContent(rows);
  let head = end;
  while (head >= 0 && !/^\s*Question \d+\/\d+\b/.test(rows[head])) head--;
  if (head < 0) return null;
  const position = /Question (\d+)\/(\d+)/.exec(rows[head])!;
  let index = optionStart(rows, head, end, '›');
  if (index < 0) return null;
  const title = rows.slice(head + 1, index).map(row => row.trim()).filter(Boolean);
  const options: Draft[] = [];
  let notes: ScreenQuestion['notes'] = null, hint: string | null = null;
  for (; index <= end; index++) {
    const row = rows[index], text = row.trim(), match = option.exec(row);
    if (!text) continue;
    if (/\benter to submit\b/i.test(text)) { hint = text; if (index !== end) return null; break; }
    if (match) {
      const draft = draftOption(match, 'answer', '›');
      const [label, ...detail] = draft.label.split(/\s{2,}/);
      draft.label = label; draft.detail = detail.join(' ');
      options.push(draft);
      continue;
    }
    const note = /^›\s?(.*)$/.exec(text);
    if (note && options.length) { notes = { open: true, text: note[1].trim() === 'Add notes' ? '' : note[1].trim() }; continue; }
    const last = options[options.length - 1];
    if (last && !notes && row.search(/\S/) > last.column) { last.detail = last.detail ? `${last.detail} ${text}` : text; continue; }
    return null;
  }
  if (!hint || !title.length || !options.length) return null;
  return {
    kind: 'question', title: title.join(' '), context: [], options: options.map(finish), hint,
    question: question('codex', { position: { index: Number(position[1]), count: Number(position[2]) }, notes: notes ?? { open: false, text: '' } }),
  };
}

export function parseQuestion(agent: ScreenAgent, rows: string[]): ScreenChoice | null {
  return agent === 'claude' ? claudeQuestion(rows) : codexQuestion(rows);
}
