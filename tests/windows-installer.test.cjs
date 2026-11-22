const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { build } = require('../package.json');

test('the Windows installer aborts initialization if Codex sandbox setup fails', () => {
  assert.equal(build.nsis.perMachine, false);
  assert.equal(build.nsis.include, 'build/installer.nsh');
  const include = fs.readFileSync(path.join(__dirname, '..', build.nsis.include), 'utf8');
  assert.match(include, /!macro customInit\b/);
  assert.match(include, /IDCANCEL agentrixCodexSetupFailed/);
  assert.match(include, /-Provision['"]\s+Pop \$0\s+\$\{EndIf\}\s+\$\{If\} \$0 != "0"\s+Goto agentrixCodexSetupFailed/);
  assert.match(include, /agentrixCodexSetupFailed:[\s\S]*?SetErrorLevel 1\s+Abort\b/);
});
