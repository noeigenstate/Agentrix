const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { en: shipped } = require('../electron/i18n.cjs');
// English a round adds in a root locale-additions-*.json counts until the lead folds it into en.json.
const root = path.join(__dirname, '..');
const en = Object.assign({}, shipped, ...fs.readdirSync(root).filter(name => /^locale-additions-[\w-]+\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))));
const { rendererLoader } = require('./helpers/hook-harness.cjs');
const { translationKeys } = require('./helpers/source-structure.cjs');
const { WHATS_NEW } = require('../src/features/guide/guide.ts');
const { listAgentCommands } = require('../electron/agent-commands.cjs');
const { THEMES } = require('../src/shared/themes.ts');

test('the Settings theme registry has English names and descriptions', () => {
  for (const { name, description } of THEMES) {
    assert.equal(typeof en[name], 'string', name);
    assert.equal(typeof en[description], 'string', description);
  }
  assert.equal(en['白底黑字'], 'Black on white');
});

// Every literal t('…') phrase in the window and the main process has an English entry,
// so switching to English never leaves a Chinese label behind.
test('every interface phrase has an English translation', () => {
  const root = path.join(__dirname, '..');
  const missing = new Set();
  const check = (file, key) => {
    if (/[一-鿿]/.test(key) && !Object.hasOwn(en, key)) missing.add(path.basename(file) + ': ' + key);
  };
  for (const name of fs.readdirSync(path.join(root, 'src'), { recursive: true })) {
    if (/\.tsx?$/.test(name)) for (const key of translationKeys(path.join('src', name))) check(name, key);
  }
  const files = ['electron'].flatMap(folder => fs.readdirSync(path.join(root, folder), { recursive: true })
    .filter(name => /\.(tsx?|cjs)$/.test(name)).map(name => path.join(root, folder, name)));
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      const key = match[1].replace(/\\'/g, "'");
      if (/[一-鿿]/.test(key) && !Object.prototype.hasOwnProperty.call(en, key)) missing.add(`${path.basename(file)}: ${key}`);
    }
  }
  assert.deepEqual([...missing], []);
});

test('shortcut action names and the guide release notes are translated too', () => {
  const { SHORTCUT_ACTIONS } = rendererLoader()('src/features/shortcuts/shortcuts.ts');
  const labels = [...SHORTCUT_ACTIONS.map(action => action.label), ...WHATS_NEW.flatMap(note => [note.title, note.text])];
  assert.ok(labels.length >= 15);
  assert.deepEqual(labels.filter(label => !Object.prototype.hasOwnProperty.call(en, label)), []);
});

test('built-in slash command descriptions have English translations', async () => {
  const commands = [...await listAgentCommands({ agent: 'claude' }), ...await listAgentCommands({ agent: 'codex' })];
  assert.deepEqual(commands.map(item => item.description).filter(description => !Object.prototype.hasOwnProperty.call(en, description)), []);
});
