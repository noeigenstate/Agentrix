// Guards for the Completion boundary (electron/BOUNDARY.md) that no behaviour test covers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['completion-work.cjs', 'completion-history.cjs', 'prompt-queue.cjs', 'codex-activity.cjs'];
const source = file => fs.readFileSync(path.join(__dirname, '../electron', file), 'utf8');
const READ_ONLY = new Set(['open', 'stat', 'lstat', 'readdir', 'readFile']);

test('completion only observes: transcripts open read-only, no writes or processes, prompts stay in memory', () => {
  for (const file of FILES) {
    const text = source(file);
    const builtins = [...text.matchAll(/require\(\s*['"](node:[^'"]+)['"]/g)].map(match => match[1]);
    assert.deepEqual(builtins.filter(name => !['node:fs', 'node:fs/promises', 'node:path', 'node:os'].includes(name)), [], `${file} needs no process, network or electron module`);
    assert.doesNotMatch(text, /require\(\s*['"](?:electron|child_process)['"]/, `${file} must not reach electron or start processes`);
    const calls = [...text.matchAll(/\bfs(?:\.promises)?\.(\w+)\(/g)].map(match => match[1]);
    assert.deepEqual(calls.filter(name => !READ_ONLY.has(name)), [], `${file} only reads files`);
    for (const [call] of text.matchAll(/\bfs(?:\.promises)?\.open\([^)]*\)/g)) assert.match(call, /,\s*['"]r['"]\s*\)$/, `${file} opens transcripts read-only: ${call}`);
  }
  assert.doesNotMatch(source('prompt-queue.cjs'), /\brequire\(/, 'the prompt queue is kept in memory only and needs no module');
});
