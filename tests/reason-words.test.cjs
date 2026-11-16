// G10: a Reason is a code from a closed table, every code has words, and the main process builds no sentence of its own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reason, isReason, codesOf } = require('../electron/shared/reason.cjs');

const root = path.join(__dirname, '..');
const NAMESPACES = ['claude', 'dispatch', 'term', 'codex'];
const WORDS = { claude: 'claudeWords', dispatch: 'dispatchWords', term: 'termWords', codex: 'codexWords' };
const wordsOf = ns => require(`../src/shared/reason-words/${ns}.ts`)[WORDS[ns]];
const tableOf = ns => require(`../electron/shared/reasons/${ns}.cjs`).codes;
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
const HAN = /[一-鿿]/;

// English phrases a round adds in a root locale-additions-*.json are read too, until the lead folds them into en.json.
const english = { ...require('../electron/locales/en.json') };
for (const name of fs.readdirSync(root).filter(file => /^locale-additions-[\w-]+\.json$/.test(file))) Object.assign(english, JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));

test('every code in every namespace has Chinese words and an English entry, and main builds no user-facing sentence', () => {
  for (const ns of NAMESPACES) {
    const codes = codesOf(ns), words = wordsOf(ns);
    assert.ok(codes.length > 0, `${ns} has codes`);
    assert.deepEqual(Object.keys(words).sort(), [...codes].sort(), `${ns}: the words and the code table list the same codes`);
    for (const code of codes) {
      const name = code.slice(ns.length + 1), declared = tableOf(ns)[name].params || [];
      assert.match(code, /^[a-z]+\.[a-z_]+$/, code);
      assert.ok(HAN.test(words[code]), `${code} has Chinese words`);
      assert.equal(typeof english[words[code]], 'string', `${code} has an English entry for "${words[code]}"`);
      assert.deepEqual(placeholders(english[words[code]]), placeholders(words[code]), `${code}: English fills the same placeholders`);
      for (const name of placeholders(words[code])) assert.ok(declared.includes(name), `${code}: {${name}} is a declared param`);
    }
  }
  assert.deepEqual(scan('electron'), []);
});

// The sentences of main's code: a Chinese string literal inside reason(...) or assigned to a reason's detail, params or code.
function literalsInReasons(source) {
  const found = new Set();
  for (const start of source.matchAll(/\breason\(/g)) {
    let depth = 1, quote = null, i = start.index + start[0].length;
    for (; i < source.length && depth; i++) {
      const char = source[i];
      if (quote) { if (char === '\\') i++; else if (char === quote) quote = null; } else if ('\'"`'.includes(char)) quote = char;
      else if (char === '(') depth++; else if (char === ')') depth--;
    }
    if (HAN.test(source.slice(start.index, i))) found.add(source.slice(start.index, i).split('\n')[0]);
  }
  for (const line of source.split('\n')) if (/\b(?:detail|code|params)\s*:\s*['"`][^'"`]*[一-鿿]/.test(line)) found.add(line.trim());
  return [...found];
}
function scan(folder) {
  return fs.readdirSync(path.join(root, folder), { recursive: true }).filter(name => name.endsWith('.cjs'))
    .map(name => path.join(folder, name).split(path.sep).join('/')).filter(file => !file.startsWith('electron/shared/reasons/'))
    .flatMap(file => literalsInReasons(fs.readFileSync(path.join(root, file), 'utf8')).map(text => `${file}: ${text}`));
}

test('the sentence scan sees a Chinese literal in a reason call or detail, and nothing else', () => {
  assert.equal(literalsInReasons("reason('term.interrupted', { source: 'main', detail: '被中断', params: { a: (1) } })").length, 1);
  assert.equal(literalsInReasons("const r = { detail: '被中断' };").length, 1);
  assert.equal(literalsInReasons("reason('term.interrupted', { source: 'main', params: { name: 'a)b' } }); label('中文');").length, 0);
});

test('reason() builds a Reason from a known code and refuses anything else', () => {
  const built = reason('codex.account_read_failed', { source: 'main', stage: 'rpc', observedAt: 7 });
  assert.deepEqual(built, { code: 'codex.account_read_failed', source: 'main', stage: 'rpc', observedAt: 7 });
  assert.ok(isReason(built));
  for (const params of [{ variable: 'ALL_PROXY', source: 'settings' }, { variable: 7, source: false }, { variable: null }, {}]) assert.ok(isReason(reason('term.hooks_command_proxy', { source: 'main', params })), JSON.stringify(params));
  assert.equal(codesOf('term').includes('term.hooks_command_proxy'), true);
  for (const [code, fields] of [
    ['term.not_a_code', { source: 'main' }], ['nothing', { source: 'main' }], ['term.constructor', { source: 'main' }], [7, { source: 'main' }],
    ['term.menu_open', {}], ['term.menu_open', { source: 'main', params: { list: ['a'] } }], ['term.menu_open', { source: 'main', params: { nested: { a: 1 } } }],
    ['term.menu_open', { source: 'main', stage: 'rpc' }], ['codex.account_read_failed', { source: 'main', stage: 'later' }],
  ]) assert.throws(() => reason(code, fields), /Invalid reason/, `${code} ${JSON.stringify(fields)}`);
  assert.throws(() => codesOf('budget'), /Unknown reason namespace/);
  assert.equal(isReason({ ...built, code: 'claude.budget_spent' }), false);
  assert.equal(isReason(null), false);
});

// The words come from the code alone, so a Reason carries no sentence of its own and no fact the table does not name.
test('a Reason has only the declared fields and the params its code declares', () => {
  const built = reason('codex.not_found', { source: 'main', params: { searched: 'a; b', pathFolders: 'c' }, observedAt: 7 });
  for (const [code, fields] of [
    ['codex.not_found', { source: 'main', params: { bogus: 'y' } }],
    ['codex.not_found', { source: 'main', params: { searched: 'a', bogus: 'y' } }],
    ['codex.failed', { source: 'main', params: { searched: 'a' } }],
    ['codex.not_found', { source: 'main', message: '中文句子' }],
    ['codex.not_found', { code: 'codex.failed', source: 'x', params: { searched: 'a' } }],
  ]) assert.throws(() => reason(code, fields), /Invalid reason/, `${code} ${JSON.stringify(fields)}`);
  assert.equal(isReason({ ...built, message: '中文句子' }), false);
  assert.equal(isReason({ ...built, params: { bogus: 'y' } }), false);
  assert.equal(isReason(built), true);
});

test('a reason detail is one redacted line of at most 300 characters', () => {
  const detail = reason('claude.failed', { source: 'main', detail: `first line\nAuthorization: Bearer abc123def\n${'x'.repeat(500)}` }).detail;
  assert.ok(detail.length <= 300 && !/[\r\n]/.test(detail));
  assert.ok(!detail.includes('abc123def'));
  assert.equal(reason('claude.failed', { source: 'main', detail: '' }).detail, undefined);
  assert.equal(isReason({ code: 'claude.failed', source: 'main', observedAt: 1, detail: 'a\nb' }), false);
});
