const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scripts = path.resolve(__dirname, '../scripts');
const marker = '// codex-home: real login on purpose (live scenario, run by hand)';
const sets = name => new RegExp(`\\b${name}\\s*(?::|=(?!=))|\\[['"]${name}['"]\\]\\s*=(?!=)`);

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : /\.(?:mjs|cjs|js|ps1|sh|py|cmd|bat)$/i.test(entry.name) ? [file] : [];
  });
}

function isolatedOrLive(source) {
  const lines = source.split(/\r?\n/);
  const code = lines.filter(line => !/^\s*(?:\/\/|#|\*)/.test(line)).join('\n');
  return !sets('AGENTRIX_DATA_DIR').test(code) || sets('CODEX_HOME').test(code)
    || /\.\.\.\s*isolatedEnvironment\s*\(/.test(code) || lines.some(line => line.trim() === marker);
}

test('every script with an Agentrix profile isolates Codex or marks a live login', () => {
  const sources = files(scripts).map(file => ({ name: path.relative(scripts, file), source: fs.readFileSync(file, 'utf8') }));
  assert.ok(sources.some(({ source }) => sets('AGENTRIX_DATA_DIR').test(source)), 'the guard found profile scripts');
  assert.deepEqual(sources.filter(({ source }) => !isolatedOrLive(source)).map(({ name }) => name), []);
  for (const name of ['routing-acceptance.mjs', 'reading-live.mjs', 'slash-live.mjs']) {
    const lines = fs.readFileSync(path.join(scripts, name), 'utf8').split(/\r?\n/);
    const index = lines.findIndex(line => line.trim() === marker);
    assert.ok(index >= 0 && sets('AGENTRIX_DATA_DIR').test(lines[index + 1] || ''), `${name}: marker must precede the profile environment`);
    assert.match(lines[index + 1], /\.\.\.process\.env\b/, `${name}: live environment must inherit process.env`);
    assert.doesNotMatch(lines[index + 1], sets('CODEX_HOME'), `${name}: live environment must inherit CODEX_HOME`);
  }
});

test('profile guard accepts isolated and marked live scripts, and rejects missing homes', () => {
  const profile = 'const env = { AGENTRIX_DATA_DIR: profile };';
  assert.equal(isolatedOrLive('const env = { AGENTRIX_DATA_DIR: profile, CODEX_HOME: home };'), true);
  assert.equal(isolatedOrLive(profile), false);
  assert.equal(isolatedOrLive(`${marker}\n${profile}`), true);
  assert.equal(isolatedOrLive('const env = { ...isolatedEnvironment(home), AGENTRIX_DATA_DIR: profile };'), true);
});
