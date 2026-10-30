// The roundtable minutes as a page the owner reads before work starts: one row per worker's understanding, then the
// questions raised and how they were settled. Plain Node (built-ins only, no file reads), carried by the dispatch helper
// (integration/dispatch.cjs RUNTIME_FILES); `node dispatch.cjs minutes` writes it beside the Markdown minutes.
//
// minutes: { meeting, round, generatedAt (ms), language ('zh' | 'en'; anything else reads as zh),
//   rows: [{ who, title, files, goal, provides, uses, doneWhen, questions,
//     status: 'confirmed' | 'open' | 'understood' | 'incomplete' | 'invalid' }],
//   issues: [{ issue, raisedBy, answer, result }] }
// A value is text or a list of lines; empty or "none" shows as "—"; a missing or unknown status shows as incomplete,
// with an unknown value written after it in parentheses. Both tables always show, with one note row when empty.
const ZH = {
  lang: 'zh-CN',
  round: round => `第 ${round} 轮圆桌`,
  generated: '生成于',
  summary: (confirmed, total) => `已确认 ${confirmed} / ${total}`,
  understandings: '各子模型的理解',
  columns: ['子模型', '任务', '负责的文件', '提供的接口', '用到的接口', '怎样算完成', '疑问或风险', '状态'],
  noRows: '还没有子模型的记录',
  issues: '分歧与答复',
  issueColumns: ['分歧或疑问', '谁提出', '主模型的答复', '结果'],
  noIssues: '没有分歧或疑问',
  statuses: { confirmed: '✅ 已确认', open: '⚠️ 待澄清', understood: '📝 已复述', incomplete: '✖ 不完整', invalid: '✖ 不完整' },
};
const EN = {
  lang: 'en',
  round: round => `Round ${round} roundtable`,
  generated: 'Generated',
  summary: (confirmed, total) => `Confirmed ${confirmed} of ${total}`,
  understandings: 'What each worker understood',
  columns: ['Worker', 'Task', 'Files owned', 'Provides', 'Uses', 'Done when', 'Questions or risks', 'Status'],
  noRows: 'No worker has answered yet',
  issues: 'Disagreements and answers',
  issueColumns: ['Disagreement or question', 'Raised by', "Lead's answer", 'Result'],
  noIssues: 'No disagreements or questions',
  statuses: { confirmed: '✅ Confirmed', open: '⚠️ Open', understood: '📝 Understood', incomplete: '✖ Incomplete', invalid: '✖ Incomplete' },
};

// The app's own greys: dark by default, the light theme (白底黑字) when the viewer prefers it.
const STYLE = `
:root { color-scheme: dark; --canvas: #181818; --panel: #262626; --well: #2d2d2d; --border: #424242; --divider: #333333; --text-1: #f2f2f2; --text-2: #b5b5b5; }
@media (prefers-color-scheme: light) {
  :root { color-scheme: light; --canvas: #f8f9fb; --panel: #ffffff; --well: #f3f5f7; --border: #e4e7eb; --divider: #ecedf0; --text-1: #24272d; --text-2: #69717d; }
}
body { margin: 0; background: var(--canvas); color: var(--text-1); font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
main { max-width: 1440px; margin: 0 auto; padding: 32px 24px 48px; }
h1 { margin: 0 0 8px; font-size: 22px; }
h2 { margin: 32px 0 16px; font-size: 16px; }
p { margin: 0; }
.meta, .empty { color: var(--text-2); }
.summary { margin-top: 16px; font-weight: 600; }
.panel { overflow-x: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 16px; }
.panel:focus-visible { outline: 2px solid var(--text-2); }
table { width: 100%; min-width: 40rem; border-collapse: separate; border-spacing: 0; }
table.wide { min-width: 80rem; }
th, td { padding: 8px 16px; text-align: left; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; }
td { min-width: 9rem; border-top: 1px solid var(--divider); background: var(--panel); }
th { white-space: nowrap; font-weight: 600; color: var(--text-2); background: var(--well); }
td.empty { min-width: 0; }
.wide :is(th, td):first-child:not(.empty) { position: sticky; left: 0; z-index: 1; box-shadow: inset -1px 0 var(--divider); }
.wide :is(th, td):last-child:not(.empty) { position: sticky; right: 0; z-index: 1; box-shadow: inset 1px 0 var(--divider); }
.goal { display: block; margin-top: 8px; color: var(--text-2); }
.files { min-width: 18rem; overflow-wrap: break-word; font: 12px/1.5 ui-monospace, Consolas, monospace; }
.file { display: block; padding-left: 16px; text-indent: -16px; }
.file + .file { margin-top: 8px; }
.status { white-space: nowrap; }
`;

// Shared with the Markdown minutes (team.cjs): the issue fields, what counts as empty, and the time format.
const ISSUE_KEYS = ['issue', 'raisedBy', 'answer', 'result'];
const lines = value => (Array.isArray(value) ? value.join('\n') : String(value ?? '')).trim();
const blank = value => !lines(value) || /^none$/i.test(lines(value));
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const text = value => blank(value) ? '—' : escape(lines(value));
// A status as its mark and word; anything unknown reads as incomplete, keeping the unknown value.
const statusWord = (t, value) => Object.hasOwn(t.statuses, value) ? t.statuses[value] : `${t.statuses.incomplete}${blank(value) ? '' : ` (${lines(value)})`}`;
const pad = number => String(number).padStart(2, '0');
const stamp = ms => {
  const date = new Date(ms);
  return typeof ms !== 'number' || Number.isNaN(date.getTime()) ? '—'
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function minutesPage(minutes) {
  const t = minutes.language === 'en' ? EN : ZH;
  const rows = minutes.rows ?? [], issues = minutes.issues ?? [];
  const heading = `${t.round(text(minutes.round))} · ${text(minutes.meeting)}`;
  // Each file is its own block, and a path may break after a separator, so a wrapped line is told from the next file.
  const files = value => blank(value) ? '—' : lines(value).split(/\r?\n/).filter(line => line.trim())
    .map(line => `<span class="file">${escape(line.trim()).replace(/[/\\]/g, '$&<wbr>')}</span>`).join('');
  const cells = (values, classes = []) => values.map((value, index) => `<td${classes[index] ? ` class="${classes[index]}"` : ''}>${value}</td>`).join('');
  const section = (title, columns, items, row, empty, wide = '') => `<section>
<h2>${title}</h2>
<div class="panel" role="region" aria-label="${title}" tabindex="0"><table${wide}><thead><tr>${columns.map(column => `<th>${column}</th>`).join('')}</tr></thead><tbody>${items.length
    ? items.map(item => `<tr>${row(item)}</tr>`).join('') : `<tr><td class="empty" colspan="${columns.length}">${empty}</td></tr>`}</tbody></table></div>
</section>`;
  const understanding = row => cells([
    text(row.who), `<strong>${text(row.title)}</strong><span class="goal">${text(row.goal)}</span>`, files(row.files),
    text(row.provides), text(row.uses), text(row.doneWhen), text(row.questions), escape(statusWord(t, row.status)),
  ], ['', '', 'files', '', '', '', '', 'status']);
  return `<!DOCTYPE html>
<html lang="${t.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading}</title><style>${STYLE}</style></head><body><main>
<h1>${heading}</h1>
<p class="meta">${t.generated} ${stamp(minutes.generatedAt)}</p>
<p class="summary">${t.summary(rows.filter(row => row.status === 'confirmed').length, rows.length)}</p>
${section(t.understandings, t.columns, rows, understanding, t.noRows, ' class="wide"')}
${section(t.issues, t.issueColumns, issues, item => cells(ISSUE_KEYS.map(key => text(item[key]))), t.noIssues)}
</main></body></html>
`;
}

module.exports = { minutesPage, LABELS: { zh: ZH, en: EN }, ISSUE_KEYS, blank, stamp, statusWord };
