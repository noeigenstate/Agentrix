const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { en } = require('../electron/i18n.cjs');
const { listAgentCommands } = require('../electron/agent-commands.cjs');

// Every literal t('…') phrase in the window and the main process has an English entry,
// so switching to English never leaves a Chinese label behind.
test('every interface phrase has an English translation', () => {
  const root = path.join(__dirname, '..');
  const files = ['src', 'electron'].flatMap(folder => fs.readdirSync(path.join(root, folder), { recursive: true })
    .filter(name => /\.(tsx?|cjs)$/.test(name)).map(name => path.join(root, folder, name)));
  const missing = new Set();
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      const key = match[1].replace(/\\'/g, "'");
      if (/[一-鿿]/.test(key) && !Object.prototype.hasOwnProperty.call(en, key)) missing.add(`${path.basename(file)}: ${key}`);
    }
  }
  assert.deepEqual([...missing], []);
});

test('shortcut action names and the guide release notes are translated too', () => {
  const shortcuts = fs.readFileSync(path.join(__dirname, '..', 'src', 'features/shortcuts/shortcuts.ts'), 'utf8');
  const guide = fs.readFileSync(path.join(__dirname, '..', 'src', 'features/guide/guide.ts'), 'utf8');
  const labels = [...shortcuts.matchAll(/label: '([^']+)'/g), ...guide.matchAll(/^\s*'([^']+)',$/gm)].map(match => match[1]);
  assert.ok(labels.length >= 15);
  assert.deepEqual(labels.filter(label => !Object.prototype.hasOwnProperty.call(en, label)), []);
});

test('built-in slash command descriptions have English translations', async () => {
  const commands = [...await listAgentCommands({ agent: 'claude' }), ...await listAgentCommands({ agent: 'codex' })];
  assert.deepEqual(commands.map(item => item.description).filter(description => !Object.prototype.hasOwnProperty.call(en, description)), []);
});
