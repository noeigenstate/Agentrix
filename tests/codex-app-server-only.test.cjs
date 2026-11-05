require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

const { argumentsOf, commandOf } = require('../integration/dispatch.cjs');
const { calls, violations } = require('./fixtures/codex-launch-sites.cjs');
const admitted = require('./fixtures/codex-launch-sites.json');
function files(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? files(file) : /\.(?:cjs|js|ts|tsx|py)$/.test(file) ? [file] : [];
  });
}
test('product Codex command builders cannot restore exec or terminal input', () => {
  const root = path.resolve(__dirname, '..'), allow = new Set(admitted.map(site => site.id)), actual = new Set();
  for (const file of ['electron', 'integration', 'src'].flatMap(folder => files(path.join(root, folder)))) {
    const name = path.relative(root, file).split(path.sep).join('/'), source = fs.readFileSync(file, 'utf8');
    assert.deepEqual(violations(source, name, allow), [], name + ': a process or terminal write callsite needs explicit review');
    for (const site of calls(source, name)) actual.add(site.id);
  }
  assert.deepEqual([...allow].filter(id => !actual.has(id)), [], 'remove obsolete callsite admissions');
  for (const resume of [[], ['--resume', '22222222-2222-4222-8222-222222222222']]) {
    const options = argumentsOf(['codex', '--role', 'exec', '--title', 'Offline', '--model', 'fixture', '--effort', 'high',
      '--cwd', os.tmpdir(), '--brief', 'brief.md', '--out', 'out.md', ...resume]);
    assert.deepEqual(commandOf(options), ['app-server', '--listen', 'stdio://']);
  }
  assert.equal(require('../electron/session-restore.cjs').resumeCommand, undefined);
  assert.equal(fs.existsSync(path.join(root, 'electron/features/terminal/native-session.cjs')), false);
});
test('all fourteen review regressions and Python process launches require admission', () => {
  const samples = [
    "terminal.write('codex\\r')",
    "const args=['exec','--skip-git-repo-check','-'];spawn(file,args)",
    "return ['exec',...settings,'-C',cwd,'-o',out,...images,'-s',sandbox,'-']",
    "spawn(file,['ex'+'ec','--json'])",
    "const EXEC='exec';spawn(file,[EXEC,'--json'])",
    "resolveExecutable('codex',['exec','--full-auto'])",
    "pty.spawn('codex',[])",
    "pty.spawn(cli.file,[...prefix,'--remote',address])",
    "terminal.write('codex --yolo\\r')",
    "terminal.write('codex\\n')",
    "terminal.write('codex'+'\\r')",
    "terminal.write(`codex -m ${model}\\r`)",
    "terminal.write(`${bin} resume ${id}\\r`)",
    "return ['exec','-m',options.model,'--json']",
  ];
  for (const sample of samples) assert.ok(violations(sample, 'sample.cjs').length, sample);
  assert.ok(violations("const start = spawn; start(file,args)", 'sample.cjs').length);
  assert.ok(violations("const {spawn:start}=require('child_process');start(file,args)", 'sample.cjs').length);
  const prior = 'function send(command){ terminal.write(command); }';
  const allowed = new Set(calls(prior, 'existing.cjs').map(site => site.id));
  assert.ok(violations(prior.replace('terminal.write', "command='codex';terminal.write"), 'existing.cjs', allowed).length,
    'changing the enclosing control flow invalidates an admitted write');
  assert.ok(violations('subprocess.Popen([bin, "exec"])', 'sample.py').length);
  assert.ok(violations("const args=['app-server'];spawn(file,args)", 'sample.cjs').length,
    'even superficially safe new launches require explicit review');
});

test('test team admission refuses the actual repository even when Git ceiling was omitted', () => {
  const { projectTeam } = require('../electron/features/team/team.cjs');
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  delete process.env.GIT_CEILING_DIRECTORIES;
  try { assert.equal(projectTeam(path.resolve(__dirname, '..'), true), null); }
  finally { if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previous; }
});
