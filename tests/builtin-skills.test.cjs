const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { builtinMetadata } = require('../electron/features/skills/builtin-format.cjs');
const { SkillsStore } = require('../electron/features/skills/store.cjs');
const { MAX_BYTES } = require('../electron/features/skills/files.cjs');
const { startupNote } = require('../electron/features/agents/handoff.cjs');

const resources = path.join(__dirname, '../resources/skills');
const body = '# Example skill\n\n## When this applies\n\nUse when the task fits; the project copy takes precedence.\n\n## What to do\n\n1. Read the task and follow the procedure.\n\n## Rules\n\n- Preserve existing behavior.\n\n## Done when\n\n- The checks pass and the result is reported.\n';
const builtin = (name = 'example', fields = {}) => Object.entries({ name,
  description: 'Use when the task needs it; follow a tested procedure.', trigger: 'auto', when: '描述匹配时生效', requires: 'none',
  title: '示例技能', summary: '按步骤处理任务。', ...fields })
  .map(([key, value]) => `${key}: ${value}`).join('\n').replace(/^/, '---\n') + '\n---\n\n' + body;
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const normalized = value => value.replace(/\\/g, '/');
const firstInstruction = (file, trigger = 'always') => `Before ${trigger === 'always' ? 'any task' : 'the first task of this session'}, read and follow ${normalized(file)}; this is its first run in this project.`;
const alwaysInstruction = file => `Before any task, read and follow ${normalized(file)}.`;
const note = delivery => startupNote('Read.', null, null, delivery);
const start = (store, project, sessionId, agent = 'codex') => store.delivery(project, project.kind === 'ssh', sessionId, { agent, started: true });

function fixture(t, setup = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-builtin-skills-'));
  const dataDir = path.join(root, 'profile'), builtinDir = path.join(root, 'builtins');
  const projects = ['First', 'Second', 'Remote'].map((name, index) => ({ id: `p${index}`, name, path: path.join(root, name), ...(index === 2 ? { kind: 'ssh' } : {}) }));
  for (const project of projects) fs.mkdirSync(project.path);
  put(path.join(builtinDir, 'model-routing', 'SKILL.md'), builtin('model-routing', { requires: 'both' }));
  put(path.join(builtinDir, 'code-standard', 'SKILL.md'), builtin('code-standard', { trigger: 'always' }));
  const errors = [], changes = [];
  const options = { dataDir, builtinDir, getProjects: () => projects, getAgents: () => ({ codex: { installed: true }, claude: { installed: false } }),
    report: error => errors.push(error), changed: (...args) => changes.push(args) };
  setup({ root, dataDir, builtinDir, projects });
  const store = new SkillsStore(options);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, builtinDir, projects, store, options, errors, changes };
}

test('strict built-in format accepts all allowed triggers/requires, scalar quoting, BOM, CRLF and length boundaries', () => {
  for (const trigger of ['always', 'auto', 'first-open']) for (const requires of ['none', 'any-agent', 'codex', 'claude', 'both']) {
    const fields = builtinMetadata(builtin('example', { trigger, requires }), 'example');
    assert.equal(fields.trigger, trigger); assert.equal(fields.requires, requires);
    assert.deepEqual(Object.keys(fields), ['name', 'description', 'trigger', 'when', 'requires', 'title', 'summary']);
  }
  for (const timing of ['when', 'before', 'on', 'at', 'whenever']) {
    const description = `Use ${timing} a task needs it; follow the procedure.`;
    assert.equal(builtinMetadata(builtin('example', { description }), 'example').description, description);
  }
  const prefix = 'Use when ';
  const limits = builtin('example', { title: '一二三四五六七八', summary: '中'.repeat(89) + '。', description: prefix + 'x'.repeat(2000 - prefix.length) });
  assert.doesNotThrow(() => builtinMetadata(limits, 'example'));
  const quoted = builtin('example', { summary: "'审查代码: 先报告问题。'", description: '"Use when reviewing code: report findings."' });
  assert.equal(builtinMetadata('\uFEFF' + quoted.replace(/\n/g, '\r\n'), 'example').summary, '审查代码: 先报告问题。');
  const fenced = builtin().replace('1. Read the task and follow the procedure.', '1. Read the example.\n\n````markdown\n## Example heading\n```\n## Still inside the example\n````');
  assert.doesNotThrow(() => builtinMetadata(fenced, 'example'));
});

test('strict built-in format rejects bad fields, limits, scalars and body sections', () => {
  const good = builtin();
  const bad = {
    'missing front matter': body,
    'missing key': good.replace('requires: none\n', ''),
    'extra key': good.replace('requires: none', 'requires: none\nextra: nope'),
    'wrong order': good.replace('trigger: auto\nwhen: 描述匹配时生效', 'when: 描述匹配时生效\ntrigger: auto'),
    'old order': good.replace(/(description: [^\n]+\n)(trigger: [^\n]+\n)(when: [^\n]+\n)(requires: [^\n]+\n)(title: [^\n]+\n)(summary: [^\n]+\n)/, '$5$6$1$2$3$4'),
    'duplicate key': good.replace('requires: none', 'trigger: auto'),
    'mismatched folder': builtin('another'),
    'non-kebab name': builtin('bad_name'),
    'oversized name': builtin('x'.repeat(121)),
    'short title': builtin('example', { title: '规' }),
    'long title': builtin('example', { title: '一二三四五六七八九' }),
    'English title': builtin('example', { title: 'Example' }),
    'long summary': builtin('example', { summary: '中'.repeat(91) }),
    'English summary': builtin('example', { summary: 'Use a procedure.' }),
    'three-sentence summary': builtin('example', { summary: '先审查。再修改。后总结。' }),
    'missing Use trigger': builtin('example', { description: 'Follow a procedure.' }),
    'trigger after description': builtin('example', { description: 'Follow a procedure. Use when reviewing code.' }),
    'wrong trigger case': builtin('example', { description: 'use when reviewing code; follow the procedure.' }),
    'trigger without a word boundary': builtin('example', { description: 'Use wheneverneeded; follow the procedure.' }),
    'trigger without a condition': builtin('example', { description: 'Use when' }),
    'Chinese description': builtin('example', { description: 'Use when reviewing code; 审查代码。' }),
    'long description': builtin('example', { description: 'Use when ' + 'x'.repeat(2000) }),
    'bad trigger': builtin('example', { trigger: 'sometimes' }),
    'English timing': builtin('example', { when: 'Before a task.' }),
    'two-sentence timing': builtin('example', { when: '先审查。再修改。' }),
    'bad requires': builtin('example', { requires: 'either' }),
    'empty scalar': builtin('example', { when: '' }),
    'multiline scalar': builtin('example', { summary: '>\n  审查代码。' }),
    'quoted newline': builtin('example', { summary: '"审查\\n代码。"' }),
    'quoted line separator': builtin('example', { summary: '"审查\\u2028代码: 先报告。"' }),
    'unnecessary quotes': builtin('example', { trigger: '"auto"' }),
    'unclosed quote': builtin('example', { summary: "'审查代码。" }),
    'YAML comment': builtin('example', { when: '描述匹配时生效 # comment' }),
    'unquoted colon': builtin('example', { summary: '审查代码: 先报告问题。' }),
    'missing heading': good.replace('## Rules\n', ''),
    'wrong heading order': good.replace('## Rules', '## Placeholder').replace('## Done when', '## Rules').replace('## Placeholder', '## Done when'),
    'extra heading': good + '\n## Extra\nNo extra sections.\n',
    'indented extra heading': good + '\n  ## Extra\nNo extra sections.\n',
    'tabbed extra heading': good + '\n##\tExtra\nNo extra sections.\n',
    'extra title': good + '\n# Another title\n',
    'wrong title level': good.replace('# Example skill', '### Example skill'),
    'Chinese body': good.replace('Preserve existing behavior.', '保持行为不变。'),
    'unnumbered steps': good.replace('1. Read the task', 'Read the task'),
    'missing bullets': good.replace('- Preserve existing behavior.', 'Preserve existing behavior.'),
    'empty section': good.replace('- The checks pass and the result is reported.', ''),
    'unclosed fence': good + '\n```\nunfinished',
    NUL: good + '\0',
    'oversized file': good + 'x'.repeat(MAX_BYTES),
  };
  for (const [label, text] of Object.entries(bad)) assert.throws(() => builtinMetadata(text, 'example'), undefined, label);
});

test('every shipped built-in passes the strict format and has English title, summary and timing', () => {
  const english = JSON.parse(fs.readFileSync(path.join(__dirname, '../electron/locales/en.json'), 'utf8'));
  const folders = fs.readdirSync(resources, { withFileTypes: true }).filter(entry => entry.isDirectory());
  assert.ok(folders.length);
  for (const folder of folders) {
    const fields = builtinMetadata(fs.readFileSync(path.join(resources, folder.name, 'SKILL.md'), 'utf8'), folder.name);
    assert.deepEqual(Object.keys(fields), ['name', 'description', 'trigger', 'when', 'requires', 'title', 'summary']);
    assert.match(fields.description, /^Use (when|before|on|at|whenever)\b/, `${folder.name} description trigger`);
    for (const key of ['title', 'summary', 'when']) assert.match(english[fields[key]] || '', /[A-Za-z]/, `${folder.name} ${key} translation`);
  }
});

test('shipped descriptions include trigger timing and project precedence', () => {
  const fields = name => builtinMetadata(fs.readFileSync(path.join(resources, name, 'SKILL.md'), 'utf8'), name);
  const routing = fields('model-routing'), standard = fields('code-standard'), ui = fields('ui-standard');
  assert.equal(routing.trigger, 'auto');
  assert.match(routing.description, /^Use before any task that is more than a quick answer or a one-line change/);
  assert.match(routing.description, /unless the project has its own model-routing skill/);
  assert.equal(routing.when, '任务需要规划、开发、调试、审查或发布时生效；项目已有同名技能时以项目为准');
  assert.equal(standard.trigger, 'always');
  assert.match(standard.description, /^Use before every task in any project that has no code standard of its own/);
  assert.match(standard.description, /on its first run in a project/);
  assert.match(standard.description, /yield to the project's own standard/);
  assert.equal(standard.when, '每个任务开始前生效；在项目里第一次运行时先审查现有代码并提出接入计划');
  assert.deepEqual([ui.trigger, ui.requires, ui.title], ['auto', 'none', '界面规范']);
  assert.match(ui.description, /^Use when designing, building, restyling or reviewing any user interface/);
});

test('invalid built-ins warn and skip only the invalid file, including an invalid replacement', t => {
  const warnings = []; t.mock.method(console, 'warn', message => warnings.push(message));
  const { store, builtinDir, projects, errors } = fixture(t, ({ builtinDir }) => put(path.join(builtinDir, 'broken', 'SKILL.md'), '---\nname: broken\n---\n'));
  assert.equal(store.infos().length, 2);
  assert.ok(warnings.some(message => message.includes('broken'))); assert.ok(errors.length);
  const file = path.join(builtinDir, 'code-standard', 'SKILL.md');
  put(file, fs.readFileSync(file, 'utf8').replace('trigger: always', 'trigger: invalid'));
  assert.doesNotThrow(() => store.refresh());
  assert.deepEqual(store.infos().map(skill => skill.name), ['model-routing']);
  assert.ok(warnings.some(message => message.includes('code-standard')));
  assert.doesNotMatch(note(store.delivery(projects[0])), /code-standard/);
});

test('defaults, timing and requirements come from front matter for any built-in name', async t => {
  const { store, options, builtinDir } = fixture(t, ({ builtinDir }) => {
    for (const [index, requires] of ['none', 'any-agent', 'codex', 'claude', 'both'].entries()) put(path.join(builtinDir, requires, 'SKILL.md'), builtin(requires, { requires, trigger: ['auto', 'always', 'first-open'][index % 3] }));
  });
  for (const codex of [false, true]) for (const claude of [false, true]) {
    options.getAgents = store.getAgents = () => ({ codex: { installed: codex }, claude: { installed: claude } });
    const infos = store.infos();
    for (const requires of ['none', 'any-agent', 'codex', 'claude', 'both']) {
      const skill = infos.find(skill => skill.name === requires), fields = builtinMetadata(fs.readFileSync(path.join(builtinDir, requires, 'SKILL.md'), 'utf8'), requires);
      assert.equal(skill.trigger, fields.trigger); assert.equal(skill.when, fields.when);
      assert.deepEqual(skill.requires, requires === 'none' ? null : { codex: requires === 'claude' ? null : codex, claude: requires === 'codex' ? null : claude });
    }
  }
  const saved = await store.save(null, { name: 'user-skill', description: 'A user procedure.', scope: 'global', projectId: null, text: '# Procedure' });
  const english = JSON.parse(fs.readFileSync(path.join(__dirname, '../electron/locales/en.json'), 'utf8'));
  for (const [trigger, when] of Object.entries({ always: '每个任务开始前', auto: '描述匹配时', 'first-open': '首次打开项目时' })) {
    const skill = store.setOptions(saved.id, { trigger });
    assert.equal(skill.when, when); assert.deepEqual(skill.yieldsTo, []); assert.equal(skill.requires, null);
    assert.match(english[when], /[A-Za-z]/);
  }
  store.setOptions('builtin:none', { trigger: 'always' });
  store.close(); const reopened = new SkillsStore(options); t.after(() => reopened.close());
  assert.equal(reopened.info(reopened.entry('builtin:none')).trigger, 'always');
});

for (const place of ['skills', '.claude/skills', '.codex/skills', 'AGENTS.md', 'CLAUDE.md']) for (const agent of ['claude', 'codex']) test(`${agent} built-ins yield to ${place} only where applicable, with watcher updates`, async t => {
  const { store, projects, changes } = fixture(t), project = projects[0], target = path.join(project.path, place);
  store.syncWatchers();
  await store.watchers.get(target).poll();
  const before = start(store, project, 'before', agent);
  const first = place.endsWith('.md') ? target : path.join(target, 'code-standard');
  if (place.endsWith('.md')) put(first, 'Follow `code-standard` before changing code.');
  else fs.mkdirSync(first, { recursive: true }); // A project skill folder alone is enough; do not require SKILL.md.
  await store.watchers.get(target).poll();
  const deadline = Date.now() + 5000;
  while (!store.info(store.entry('builtin:code-standard')).yieldsTo.length) {
    assert.ok(Date.now() < deadline, 'watcher publishes project skill detection');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const info = store.info(store.entry('builtin:code-standard'));
  assert.deepEqual(info.yieldsTo, ['First']); assert.ok(changes.length);
  const yielded = store.delivery(project, false, 'after', { agent });
  const applies = place === 'skills' || place === 'AGENTS.md' || (place === '.codex/skills' ? agent === 'codex' : agent === 'claude');
  assert.notEqual(yielded, before); assert.equal(yielded.skills.some(skill => skill.id === info.id), !applies);
  const location = place.endsWith('.md') ? place : `${place}/code-standard/SKILL.md`;
  assert.equal(note(yielded).includes(`This project has its own code-standard skill at ${location}; follow it.`), applies);
  assert.equal(note(yielded).includes(normalized(info.path)), !applies);
  assert.deepEqual(store.info(store.entry('builtin:model-routing')).yieldsTo, []);
  assert.ok(store.delivery(projects[1], false, 'other').skills.some(skill => skill.id === info.id));
  projects[0].name = 'Renamed';
  assert.deepEqual(store.info(store.entry(info.id)).yieldsTo, ['Renamed']);
  if (place.endsWith('.md')) fs.unlinkSync(first); else fs.rmdirSync(first);
  store.refresh(false, new Set([target]));
  assert.deepEqual(store.info(store.entry(info.id)).yieldsTo, []);
  const after = store.delivery(project, false, 'after-removal', { agent });
  assert.equal(after.skills.find(skill => skill.id === info.id).trigger, 'always');
  assert.ok(note(after).includes(alwaysInstruction(info.path)), 'the earlier agent ran before the project adopted its own skill');
});

test('yield detection matches whole skill names only and does not scan SSH paths', t => {
  const { store, projects } = fixture(t, ({ projects }) => {
    for (const project of projects) {
      put(path.join(project.path, 'AGENTS.md'), 'pre-code-standard code-standard-extra code-standard_ignored code_standard 中文code-standard model-routing-more');
      fs.mkdirSync(path.join(project.path, 'skills', 'code-standard-extra'), { recursive: true });
    }
    put(path.join(projects[2].path, 'CLAUDE.md'), 'Follow code-standard and model-routing.');
    fs.mkdirSync(path.join(projects[2].path, '.codex/skills/code-standard'), { recursive: true });
  });
  assert.ok(store.infos().every(skill => !skill.yieldsTo.length));
  const remote = store.delivery(projects[2], true, 'remote-first');
  assert.ok(remote.bundle.files.some(file => file.id === 'builtin:code-standard'));
  assert.ok(remote.bundle.instructions.includes(firstInstruction('{AGENTRIX_SKILLS}/builtin/code-standard/SKILL.md')));
  assert.doesNotMatch(remote.bundle.instructions, /This project has its own/);
});

test('project override detection is reused for deliveries and refreshes of unrelated roots', t => {
  const { store, projects, dataDir } = fixture(t);
  const reads = t.mock.method(fs, 'readFileSync', fs.readFileSync), scans = t.mock.method(fs, 'readdirSync', fs.readdirSync);
  const delivery = store.delivery(projects[0]);
  store.delivery(projects[1]); store.delivery(projects[0]);
  store.refresh(false, new Set([path.join(dataDir, 'skills')]));
  assert.equal(store.delivery(projects[0]), delivery);
  assert.equal(scans.mock.callCount(), 1, 'only the selected global root is scanned');
  assert.equal(reads.mock.callCount(), 0, 'instruction files and skill bodies are not reread');
});

test('newly added and moved projects yield before the first watcher scan', t => {
  const { root, store, projects } = fixture(t);
  const project = { id: 'new', name: 'New project', path: path.join(root, 'new-project') };
  fs.mkdirSync(path.join(project.path, '.codex/skills/code-standard'), { recursive: true });
  projects.push(project);
  const yielded = store.delivery(project, false, 'immediate');
  assert.ok(note(yielded).includes('This project has its own code-standard skill at .codex/skills/code-standard/SKILL.md; follow it.'));
  assert.equal(store.options['builtin:code-standard']?.firstOpenedProjects, undefined);
  assert.deepEqual(store.info(store.entry('builtin:code-standard')).yieldsTo, ['New project']);
  assert.equal(store.delivery(project, false, 'immediate'), yielded);
  project.path = path.join(root, 'moved-project'); fs.mkdirSync(project.path);
  assert.ok(note(store.delivery(project, false, 'after-move')).includes(firstInstruction(store.entry('builtin:code-standard').path)));
  assert.deepEqual(store.info(store.entry('builtin:code-standard')).yieldsTo, []);
});

for (const trigger of ['always', 'first-open']) test(`${trigger} first run is claimed by an agent, never a shell or refresh`, t => {
  const { store, projects, dataDir, options } = fixture(t, ({ builtinDir }) => put(path.join(builtinDir, 'code-standard', 'SKILL.md'), builtin('code-standard', { trigger })));
  const project = projects[0], id = 'builtin:code-standard';
  const file = store.entry(id).path, preview = store.delivery(project);
  assert.ok(note(preview).includes(firstInstruction(file, trigger)));
  assert.equal(store.options[id]?.firstOpenedProjects, undefined, 'a preview does not start a session');
  store.delivery(project, false, 'shell-only');
  store.delivery(project, false, 'second-terminal');
  store.delivery(project, false, null, { agent: 'codex', started: true });
  store.refresh();
  assert.equal(store.options[id]?.firstOpenedProjects, undefined, 'opening a shell does not start an agent');
  const first = start(store, project, 'first');
  assert.ok(note(first).includes(firstInstruction(file, trigger)));
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json'), 'utf8'));
  assert.equal(persisted[id].firstOpenedProjects[project.id], 'first');
  assert.equal(store.info(store.entry(id)).trigger, trigger, 'the configured default stays visible');
  assert.equal('firstRun' in store.info(store.entry(id)), false, 'first-run status is delivery-only');
  assert.notEqual(store.delivery(project), preview, 'starting a session invalidates previews');
  const later = start(store, project, 'second');
  assert.doesNotMatch(note(later), /this is its first run/);
  assert.ok(note(later).includes(trigger === 'always' ? alwaysInstruction(file) : `code-standard: ${store.entry(id).description} (${normalized(file)})`));
  assert.equal(later.skills.find(skill => skill.id === id).trigger, trigger === 'always' ? 'always' : 'auto');
  assert.equal(store.options[id].firstOpenedProjects[project.id], 'first', 'a later terminal cannot replace the first agent');
  assert.ok(note(start(store, projects[1], 'other-project')).includes(firstInstruction(file, trigger)));
  store.invalidateDelivery();
  const sessions = new Map([['one', { projectId: project.id, terminalId: 'one', sessionId: 'first', codexActive: true, skillNoteFile: 'one.txt' }],
    ['two', { projectId: project.id, terminalId: 'two', sessionId: 'second', codexActive: true, skillNoteFile: 'two.txt' }],
    ['idle', { projectId: projects[1].id, terminalId: 'idle', sessionId: 'idle', skillNoteFile: 'idle.txt' }]]), written = new Map();
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const refresh = vm.runInNewContext('(' + main.slice(main.indexOf('function refreshSkillNotes()'), main.indexOf('// Claude Code writes')) + ')', {
    sessions, store: { projects }, skills: store, startupNote, path, integrationDir: '/synthetic/integration', handoffFile: () => null, READING_NOTE: 'Read.', writeFileAtomic: (file, text) => written.set(file, text),
  });
  refresh();
  assert.equal(written.has('one.txt'), false); assert.equal(written.has('two.txt'), false);
  assert.ok(written.has('idle.txt'));
  assert.ok(note(start(store, project, 'first')).includes(firstInstruction(file, trigger)), 'the first agent keeps its original instruction');
  store.close(); const reopened = new SkillsStore(options); t.after(() => reopened.close());
  const after = start(reopened, project, 'after-restart');
  assert.equal(after.skills.find(skill => skill.id === id).trigger, trigger === 'always' ? 'always' : 'auto');
  assert.doesNotMatch(note(after), /this is its first run/);
  assert.equal(reopened.options[id].firstOpenedProjects[project.id], 'first');
});

for (const trigger of ['always', 'first-open']) test(`disabled or yielded ${trigger} skills are not recorded as run`, t => {
  const { store, projects } = fixture(t, ({ projects, builtinDir }) => {
    put(path.join(builtinDir, 'code-standard', 'SKILL.md'), builtin('code-standard', { trigger }));
    fs.mkdirSync(path.join(projects[0].path, 'skills/code-standard'), { recursive: true });
  });
  const id = 'builtin:code-standard', project = projects[0];
  const yielded = start(store, project, 'yielded');
  assert.ok(note(yielded).includes('This project has its own code-standard skill at skills/code-standard/SKILL.md; follow it.'));
  assert.equal(store.options[id]?.firstOpenedProjects, undefined);
  fs.rmdirSync(path.join(project.path, 'skills/code-standard')); store.refresh();
  store.setOptions(id, { enabled: false }); start(store, project, 'disabled');
  assert.equal(store.options[id]?.firstOpenedProjects, undefined);
  store.setOptions(id, { enabled: true });
  assert.ok(note(start(store, project, 'enabled')).includes(firstInstruction(store.entry(id).path, trigger)));
  assert.equal(store.options[id].firstOpenedProjects[project.id], 'enabled');
});

for (const trigger of ['always', 'first-open']) test(`${trigger} skills omitted from an SSH bundle have not run`, t => {
  const { store, projects } = fixture(t, ({ builtinDir }) => {
    put(path.join(builtinDir, 'a-large', 'SKILL.md'), builtin('a-large') + 'x'.repeat(420 * 1024));
    put(path.join(builtinDir, 'code-standard', 'SKILL.md'), builtin('code-standard', { trigger }) + 'x'.repeat(120 * 1024));
  });
  const delivery = start(store, projects[2], 'remote');
  assert.ok(delivery.bundle.files.some(file => file.name === 'a-large'));
  assert.ok(!delivery.bundle.files.some(file => file.name === 'code-standard'));
  assert.equal(store.options['builtin:code-standard']?.firstOpenedProjects, undefined);
  assert.match(delivery.bundle.instructions, /omitted/);
  store.setOptions('builtin:a-large', { enabled: false });
  const included = start(store, projects[2], 'included');
  assert.ok(included.bundle.instructions.includes(firstInstruction('{AGENTRIX_SKILLS}/builtin/code-standard/SKILL.md', trigger)));
  assert.equal(store.options['builtin:code-standard'].firstOpenedProjects[projects[2].id], 'included');
  assert.doesNotMatch(start(store, projects[2], 'later').bundle.instructions, /this is its first run/);
});

for (const trigger of ['always', 'first-open']) test(`simultaneous launches claim ${trigger} first run once and the production launch boundary separates agents in one shell`, async t => {
  const { store, projects, root } = fixture(t, ({ builtinDir }) => put(path.join(builtinDir, 'code-standard', 'SKILL.md'), builtin('code-standard', { trigger })));
  const project = projects[0], id = 'builtin:code-standard';
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  let serial = 0;
  const context = vm.createContext({ skills: store, randomUUID: () => `agent-${++serial}`, path, integrationDir: '/synthetic/integration', startupNote, READING_NOTE: 'Read.',
    handoffFile: () => null, writeFileAtomic: put, report: error => { throw error; } });
  vm.runInContext(main.slice(main.indexOf('function startSkillSession('), main.indexOf('// Wrappers reread idle')), context);
  const shell = terminalId => ({ projectId: project.id, terminalId, sessionId: terminalId, agent: 'codex', skillNoteFile: path.join(root, `${terminalId}.txt`) });
  const first = shell('one'), second = shell('two');
  context.startSkillSession(project, first, 0, false);
  assert.equal(store.options[id]?.firstOpenedProjects, undefined, 'an unobserved launch cannot claim the first run');
  await Promise.all([first, second].map(s => Promise.resolve().then(() => context.startSkillSession(project, s, 1))));
  assert.match(fs.readFileSync(first.skillNoteFile, 'utf8'), /this is its first run/);
  assert.doesNotMatch(fs.readFileSync(second.skillNoteFile, 'utf8'), /this is its first run/);
  assert.equal(store.options[id].firstOpenedProjects[project.id], first.skillSessionId);
  const claimedSession = first.skillSessionId;
  const firstManifest = start(store, project, first.skillSessionId).manifest;
  context.endSkillSession(first); assert.equal(fs.existsSync(firstManifest), false);
  first.agent = 'claude'; context.startSkillSession(project, first, 2);
  assert.equal(first.sessionId, 'one'); assert.notEqual(first.skillSessionId, claimedSession);
  assert.equal(store.options[id].firstOpenedProjects[project.id], claimedSession);
  assert.doesNotMatch(fs.readFileSync(first.skillNoteFile, 'utf8'), /this is its first run/);
});

test('auto skills never claim a first run', t => {
  const { store, projects } = fixture(t), id = 'builtin:model-routing';
  const first = start(store, projects[0], 'first');
  assert.equal(first.skills.find(skill => skill.id === id).trigger, 'auto');
  assert.ok(note(first).includes(`model-routing: ${store.entry(id).description}`));
  assert.equal(store.options[id]?.firstOpenedProjects, undefined);
});

test('always skills reuse a persisted first-open claim after a default change', t => {
  const { store, projects, options } = fixture(t, ({ builtinDir }) => put(path.join(builtinDir, 'code-standard', 'SKILL.md'), builtin('code-standard', { trigger: 'first-open' })));
  const project = projects[0], id = 'builtin:code-standard', file = store.entry(id).path;
  start(store, project, 'first');
  store.close();
  put(file, builtin('code-standard', { trigger: 'always' }));
  const reopened = new SkillsStore(options); t.after(() => reopened.close());
  assert.ok(note(start(reopened, project, 'later')).includes(alwaysInstruction(file)));
  assert.ok(note(start(reopened, project, 'first')).includes(firstInstruction(file)));
  assert.equal(reopened.options[id].firstOpenedProjects[project.id], 'first');
});

test('mentions of the built-in path do not override it; yielded info is computed once per entry', t => {
  const { store, projects } = fixture(t), project = projects[0], id = 'builtin:code-standard';
  put(path.join(project.path, 'AGENTS.md'), `Follow ${store.entry(id).path.replace(/\\/g, '/')} before coding.`);
  put(path.join(project.path, 'CLAUDE.md'), `Follow ${store.entry(id).path} before coding.`);
  store.refresh(); assert.deepEqual(store.info(store.entry(id)).yieldsTo, []);
  put(path.join(project.path, 'AGENTS.md'), 'Follow code-standard.'); store.refresh();
  const infos = t.mock.method(store, 'info', store.info);
  const delivery = store.delivery(project, false, 'yielded', { agent: 'claude' });
  assert.ok(note(delivery).includes('code-standard skill at AGENTS.md; follow it.'));
  assert.equal(infos.mock.callCount(), store.entries.size);
});

test('oversized, non-file and inaccessible project instructions are silent and symlinked skill folders yield', t => {
  const { store, root, projects, errors } = fixture(t), project = projects[0];
  put(path.join(project.path, 'AGENTS.md'), 'code-standard ' + 'x'.repeat(MAX_BYTES));
  fs.mkdirSync(path.join(project.path, 'CLAUDE.md'));
  store.refresh(); assert.equal(errors.length, 0); assert.deepEqual(store.info(store.entry('builtin:code-standard')).yieldsTo, []);
  const folder = path.join(root, 'linked-skill'); fs.mkdirSync(folder);
  fs.mkdirSync(path.join(project.path, '.claude/skills'), { recursive: true });
  fs.symlinkSync(folder, path.join(project.path, '.claude/skills/code-standard'), process.platform === 'win32' ? 'junction' : 'dir');
  store.refresh();
  assert.ok(note(store.delivery(project, false, 'claude', { agent: 'claude' })).includes('at .claude/skills/code-standard/SKILL.md; follow it.'));
  assert.ok(store.delivery(project, false, 'codex', { agent: 'codex' }).skills.some(skill => skill.id === 'builtin:code-standard'));
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    if (file === path.join(project.path, 'AGENTS.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return stat(file, ...args);
  });
  assert.doesNotThrow(() => store.refresh()); assert.equal(errors.length, 0);
});

test('CLAUDE.md symlinked to AGENTS.md is followed and its target changes are detected', async t => {
  const { store, projects, errors } = fixture(t), project = projects[0];
  const target = path.join(project.path, 'AGENTS.md'), link = path.join(project.path, 'CLAUDE.md');
  put(target, 'Follow code-standard.');
  try { fs.symlinkSync(target, link, 'file'); }
  catch (error) {
    if (error.code !== 'EPERM') throw error;
    // Windows without file-symlink privilege still exercises target reads and target metadata changes.
    const stat = fs.statSync, read = fs.readFileSync, asyncStat = fs.promises.stat;
    t.mock.method(fs, 'statSync', (file, ...args) => stat(file === link ? target : file, ...args));
    t.mock.method(fs, 'readFileSync', (file, ...args) => read(file === link ? target : file, ...args));
    t.mock.method(fs.promises, 'stat', (file, ...args) => asyncStat(file === link ? target : file, ...args));
    t.diagnostic('File symlink privilege unavailable; following the link is emulated at the filesystem boundary.');
  }
  assert.equal(require('../electron/features/skills/files.cjs').readText(link), 'Follow code-standard.');
  const { projectSkillSignature } = require('../electron/features/skills/project-skills.cjs');
  const before = await projectSkillSignature(link);
  store.refresh(); assert.equal(errors.length, 0);
  assert.deepEqual(store.info(store.entry('builtin:code-standard')).yieldsTo, ['First']);
  put(target, 'No override.'); assert.notEqual(await projectSkillSignature(link), before);
  store.refresh(); assert.deepEqual(store.info(store.entry('builtin:code-standard')).yieldsTo, []); assert.equal(errors.length, 0);
});

test('session manifests are removed on exit, startup sweeps stale hashes and removed projects are pruned', t => {
  const { store, projects, options, dataDir } = fixture(t), id = 'builtin:code-standard';
  const first = start(store, projects[0], 'first'), second = start(store, projects[1], 'second');
  store.invalidateDelivery(); store.endSession(projects[0].id, 'first');
  assert.equal(fs.existsSync(first.manifest), false); assert.equal(fs.existsSync(second.manifest), true);
  const removed = projects.shift(); store.syncWatchers();
  assert.equal(store.options[id].firstOpenedProjects[removed.id], undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json'), 'utf8'))[id].firstOpenedProjects[removed.id], undefined);
  const keep = path.join(dataDir, 'skill-delivery', 'keep.md'); put(keep, 'unrelated');
  store.close(); const reopened = new SkillsStore(options); t.after(() => reopened.close());
  assert.equal(fs.existsSync(second.manifest), false); assert.equal(fs.readFileSync(keep, 'utf8'), 'unrelated');
  assert.equal(reopened.options[id].firstOpenedProjects[projects[0].id], 'second');
});
