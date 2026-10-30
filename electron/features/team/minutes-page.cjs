// The roundtable minutes as a page the owner reads before work starts: one row per worker's understanding, then the
// questions raised and how they were settled. Plain Node, carried by the dispatch helper (integration/dispatch.cjs
// RUNTIME_FILES); `node dispatch.cjs minutes` writes it beside the Markdown minutes.
//
// minutes: { meeting, round, generatedAt (ms), language ('zh' | 'en'),
//   rows: [{ who, title, files, goal, provides, uses, doneWhen, questions, status: 'confirmed' | 'open' | 'understood' | 'incomplete' }],
//   issues: [{ issue, raisedBy, answer, result }] }
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

function minutesPage(minutes) {
  const cells = row => ['who', 'title', 'files', 'goal', 'provides', 'uses', 'doneWhen', 'questions', 'status'].map(key => `<td>${escape(row[key])}</td>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Roundtable ${escape(minutes.round)}</title></head><body>
<table>${minutes.rows.map(row => `<tr>${cells(row)}</tr>`).join('')}</table>
<table>${minutes.issues.map(item => `<tr>${['issue', 'raisedBy', 'answer', 'result'].map(key => `<td>${escape(item[key])}</td>`).join('')}</tr>`).join('')}</table>
</body></html>\n`;
}

module.exports = { minutesPage };
