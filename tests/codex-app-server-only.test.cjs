const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ts = require('typescript');
const { argumentsOf, commandOf } = require('../integration/dispatch.cjs');

function forbidden(source) {
  const root = ts.createSourceFile('product.cjs', source, ts.ScriptTarget.Latest, true), found = [];
  function visit(node) {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && (/^codex(?:[ \t]+(?:exec|resume)\b|\r$)/.test(node.text))) found.push(node.getStart());
    if (ts.isArrayLiteralExpression(node)) {
      const values = node.elements.filter(ts.isStringLiteralLike).map(value => value.text);
      if (values[0] === 'exec' && values.some(value => ['-m', '--json', 'resume', '--model'].includes(value))) found.push(node.getStart());
      if (values[0] === 'codex' && values[1] === 'exec') found.push(node.getStart());
      const call = node.parent;
      if (values[0] === 'exec' && ts.isCallExpression(call) && call.arguments.includes(node)
        && /(?:spawn|launch|execFile|execFileSync|spawnSync)$/.test(call.expression.getText(root))) found.push(node.getStart());
    }
    ts.forEachChild(node, visit);
  }
  visit(root); return found;
}

test('product Codex command builders cannot restore exec or terminal input', () => {
  const root = path.resolve(__dirname, '..');
  function scan(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (file.endsWith('.cjs')) assert.deepEqual(forbidden(fs.readFileSync(file, 'utf8')), [], path.relative(root, file));
    }
  }
  scan(path.join(root, 'electron')); scan(path.join(root, 'integration'));
  assert.ok(forbidden("return ['exec', '-m', options.model, '--json'];").length);
  assert.ok(forbidden("terminal.write('codex\\r');").length);
  assert.ok(forbidden("spawn('codex', ['exec']);").length);
  assert.ok(forbidden("launch(cli.file, ['exec']);").length);
  assert.ok(forbidden("return `codex resume ${id}\\r`;").length ||
    forbidden("return 'codex resume ' + id + '\\r';").length);
  for (const resume of [[], ['--resume', '22222222-2222-4222-8222-222222222222']]) {
    const options = argumentsOf(['codex', '--role', 'exec', '--title', 'Offline', '--model', 'fixture', '--effort', 'high',
      '--cwd', os.tmpdir(), '--brief', 'brief.md', '--out', 'out.md', ...resume]);
    assert.deepEqual(commandOf(options), ['app-server', '--listen', 'stdio://']);
  }
  assert.throws(() => require('../electron/features/agents/launch.cjs').launchCommand('codex'), /app-server/);
  assert.equal(require('../electron/session-restore.cjs').resumeCommand, undefined);
  assert.throws(() => require('../electron/features/terminal/native-session.cjs').createNativeSession({ cli: { file: 'fake-only', prefix: [] } }), /已停用/);
});

test('test team admission refuses the actual repository even when Git ceiling was omitted', () => {
  const { projectTeam } = require('../electron/features/team/team.cjs');
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  delete process.env.GIT_CEILING_DIRECTORIES;
  try { assert.equal(projectTeam(path.resolve(__dirname, '..'), true), null); }
  finally { if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previous; }
});
