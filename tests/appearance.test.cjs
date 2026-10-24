const { test } = require('node:test');
const assert = require('node:assert/strict');
const { terminalFontFamily } = require('../src/features/terminal/terminal-font.ts');

test('font names remain single quoted families and missing choices retain original fallbacks', () => {
  const original = terminalFontFamily();
  assert.equal(original, "'Cascadia Mono', 'Cascadia Code', Consolas, 'SF Mono', Menlo, 'Microsoft YaHei UI', 'PingFang SC', monospace");
  assert.ok(original.startsWith("'Cascadia Mono'")); assert.ok(original.endsWith("'PingFang SC', monospace"));
  assert.ok(terminalFontFamily('Consolas', 'Noto Sans SC').startsWith("'Consolas'"));
  assert.ok(terminalFontFamily('Missing', 'Missing CJK').includes("'Cascadia Code'"));
  assert.ok(terminalFontFamily("Font'Name").startsWith("'Font\\'Name'"));
  const linuxFallback = terminalFontFamily('Missing', 'Noto Sans SC');
  assert.ok(linuxFallback.indexOf("'DejaVu Sans Mono'") < linuxFallback.indexOf("'Noto Sans SC'"));
  assert.ok(linuxFallback.indexOf("'Liberation Mono'") < linuxFallback.indexOf("'Noto Sans SC'"));
  assert.ok(terminalFontFamily('Font,Other').startsWith("'Font,Other',"));
});
