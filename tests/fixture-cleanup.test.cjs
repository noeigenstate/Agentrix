const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
test('R6 fixture cleanup uses asynchronous removal when Windows retries are requested', () => {
  function visit(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? visit(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
  }
  for (const file of visit(__dirname).filter(file => file.endsWith('.cjs'))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\brmSync\([^;]*\bmaxRetries\s*:/, path.relative(__dirname, file));
  }
});
