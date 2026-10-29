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
const builtin = (name = 'example', fields = {}) => Object.entries({ name, title: '示例技能', summary: '按步骤处理任务。',
  description: 'Follow a tested procedure. Use when the task needs it.', trigger: 'auto', when: '描述匹配时生效', requires: 'none', ...fields })
  .map(([key, value]) => `${key}: ${value}`).join('\n').replace(/^/, '---\n') + '\n---\n\n' + body;
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const normalized = value => value.replace(/\\/g, '/');
const firstInstruction = file => `Before the first task of this session, read and follow ${normalized(file)}; this is its first run in this project.`;
const note = delivery => startupNote('Read.', null, null, delivery);

function fixture(t, setup = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-builtin-skills-'));
  const dataDir = path.join(root, 'profile'), builtinDir = path.join(root, 'builtins');
  const projects = ['First', 'Second', 'Remote'].map((name, index) => ({ id: `p${index}`, name, path: path.join(root, name), ...(index === 2 ? { kind: 'ssh' } : {}) }));
  for (const project of projects) fs.mkdirSync(project.path);
  for (const name of ['model-routing', 'code-standard']) put(path.join(builtinDir, name, 'SKILL.md'), fs.readFileSync(path.join(resources, name, 'SKILL.md'), 'utf8'));
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
    assert.deepEqual(Object.keys(fields), ['name', 'title', 'summary', 'description', 'trigger', 'when', 'requires']);
  }
  const prefix = 'Follow the procedure. Use when ';
  const limits = builtin('example', { title: '一二三四五六七八', summary: '中'.repeat(89) + '。', description: prefix + 'x'.repeat(2000 - prefix.length) });
  assert.doesNotThrow(() => builtinMetadata(limits, 'example'));
  const quoted = builtin('example', { summary: "'审查代码: 先报告问题。'", description: '"Inspect code: report findings. Use when reviewing code."' });
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
    'missing Use when': builtin('example', { description: 'Follow a procedure.' }),
    'missing description before Use when': builtin('example', { description: 'Use when reviewing code.' }),
    'Chinese description': builtin('example', { description: '审查代码。 Use when reviewing code.' }),
    'long description': builtin('example', { description: 'Review code. Use when ' + ' '.repeat(2000) + 'needed.' }),
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
    for (const key of ['title', 'summary', 'when']) assert.match(english[fields[key]] || '', /[A-Za-z]/, `${folder.name} ${key} translation`);
  }
});

test('invalid built-ins warn and skip only the invalid file, including an invalid replacement', t => {
  const warnings = []; t.mock.method(console, 'warn', message => warnings.push(message));
  const { store, builtinDir, projects, errors } = fixture(t, ({ builtinDir }) => put(path.join(builtinDir, 'broken', 'SKILL.md'), '---\nname: broken\n---\n'));
  assert.equal(store.infos().length, 2);
  assert.ok(warnings.some(message => message.includes('broken'))); assert.ok(errors.length);
  const file = path.join(builtinDir, 'code-standard', 'SKILL.md');
  put(file, fs.readFileSync(file, 'utf8').replace('trigger: first-open', 'trigger: invalid'));
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

for (const place of ['skills', '.claude/skills', '.codex/skills', 'AGENTS.md', 'CLAUDE.md']) test(`built-ins yield to ${place}, with cached delivery and watcher updates`, async t => {
  const { store, projects, changes } = fixture(t), project = projects[0], target = path.join(project.path, place);
  store.syncWatchers();
  await store.watchers.get(target).poll();
  const before = store.delivery(project, false, 'before');
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
  const yielded = store.delivery(project, false, 'after');
  assert.notEqual(yielded, before); assert.ok(!yielded.skills.some(skill => skill.id === info.id));
  assert.ok(note(yielded).includes('This project has its own code-standard skill; follow it.'));
  assert.ok(!note(yielded).includes(normalized(info.path)));
  assert.deepEqual(store.info(store.entry('builtin:model-routing')).yieldsTo, []);
  assert.ok(store.delivery(projects[1], false, 'other').skills.some(skill => skill.id === info.id));
  projects[0].name = 'Renamed';
  assert.deepEqual(store.info(store.entry(info.id)).yieldsTo, ['Renamed']);
  if (place.endsWith('.md')) fs.unlinkSync(first); else fs.rmdirSync(first);
  store.refresh(false, new Set([target]));
  assert.deepEqual(store.info(store.entry(info.id)).yieldsTo, []);
  assert.equal(store.delivery(project, false, 'after-removal').skills.find(skill => skill.id === info.id).trigger, 'auto', 'the earlier session ran before the project adopted its own skill');
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
  assert.ok(note(yielded).includes('This project has its own code-standard skill; follow it.'));
  assert.equal(store.options['builtin:code-standard']?.firstOpenedProjects, undefined);
  assert.deepEqual(store.info(store.entry('builtin:code-standard')).yieldsTo, ['New project']);
  assert.equal(store.delivery(project, false, 'immediate'), yielded);
  project.path = path.join(root, 'moved-project'); fs.mkdirSync(project.path);
  assert.ok(note(store.delivery(project, false, 'after-move')).includes(firstInstruction(store.entry('builtin:code-standard').path)));
  assert.deepEqual(store.info(store.entry('builtin:code-standard')).yieldsTo, []);
});

test('first-open runs once per project, persists at session start and retains the first session note on refresh', t => {
  const { store, projects, dataDir, options } = fixture(t), project = projects[0], id = 'builtin:code-standard';
  const file = store.entry(id).path, preview = store.delivery(project);
  assert.ok(note(preview).includes(firstInstruction(file)));
  assert.equal(store.options[id]?.firstOpenedProjects, undefined, 'a preview does not start a session');
  const first = store.delivery(project, false, 'first');
  assert.ok(note(first).includes(firstInstruction(file)));
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json'), 'utf8'));
  assert.equal(persisted[id].firstOpenedProjects[project.id], 'first');
  assert.equal(store.info(store.entry(id)).trigger, 'first-open', 'the configured default stays visible');
  assert.notEqual(store.delivery(project), preview, 'starting a session invalidates previews');
  const later = store.delivery(project, false, 'second');
  assert.doesNotMatch(note(later), /this is its first run/);
  assert.ok(note(later).includes(`code-standard: ${store.entry(id).description} (${normalized(file)})`));
  assert.ok(note(store.delivery(projects[1], false, 'other-project')).includes(firstInstruction(file)));
  store.invalidateDelivery();
  const sessions = new Map([['one', { projectId: project.id, terminalId: 'one', sessionId: 'first', skillNoteFile: 'one.txt' }],
    ['two', { projectId: project.id, terminalId: 'two', sessionId: 'second', skillNoteFile: 'two.txt' }]]), written = new Map();
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const refresh = vm.runInNewContext('(' + main.slice(main.indexOf('function refreshSkillNotes()'), main.indexOf('// Claude Code writes')) + ')', {
    sessions, store: { projects }, skills: store, startupNote, path, handoffFile: () => null, READING_NOTE: 'Read.', writeSkillFile: (file, text) => written.set(file, text),
  });
  refresh();
  assert.ok(written.get('one.txt').includes(firstInstruction(file)));
  assert.doesNotMatch(written.get('two.txt'), /this is its first run/);
  store.close(); const reopened = new SkillsStore(options); t.after(() => reopened.close());
  assert.equal(reopened.delivery(project, false, 'after-restart').skills.find(skill => skill.id === id).trigger, 'auto');
});

test('disabled or yielded first-open skills are not recorded as run', t => {
  const { store, projects } = fixture(t, ({ projects }) => fs.mkdirSync(path.join(projects[0].path, 'skills/code-standard'), { recursive: true }));
  const id = 'builtin:code-standard', project = projects[0];
  const yielded = store.delivery(project, false, 'yielded');
  assert.ok(note(yielded).includes('This project has its own code-standard skill; follow it.'));
  assert.equal(store.options[id]?.firstOpenedProjects, undefined);
  fs.rmdirSync(path.join(project.path, 'skills/code-standard')); store.refresh();
  store.setOptions(id, { enabled: false }); store.delivery(project, false, 'disabled');
  assert.equal(store.options[id]?.firstOpenedProjects, undefined);
  store.setOptions(id, { enabled: true });
  assert.ok(note(store.delivery(project, false, 'enabled')).includes(firstInstruction(store.entry(id).path)));
});

test('a first-open skill omitted from an SSH bundle has not run', t => {
  const { store, projects } = fixture(t, ({ builtinDir }) => {
    put(path.join(builtinDir, 'a-large', 'SKILL.md'), builtin('a-large') + 'x'.repeat(420 * 1024));
    const file = path.join(builtinDir, 'code-standard', 'SKILL.md'); put(file, fs.readFileSync(file, 'utf8') + 'x'.repeat(120 * 1024));
  });
  const delivery = store.delivery(projects[2], true, 'remote');
  assert.ok(delivery.bundle.files.some(file => file.name === 'a-large'));
  assert.ok(!delivery.bundle.files.some(file => file.name === 'code-standard'));
  assert.equal(store.options['builtin:code-standard']?.firstOpenedProjects, undefined);
  assert.match(delivery.bundle.instructions, /omitted/);
});
