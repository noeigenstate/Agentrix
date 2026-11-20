const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { builtinMetadata } = require('../electron/features/skills/builtin-format.cjs');
const { renderRoutingSkill } = require('../electron/features/skills/skill-render.cjs');
const modelSeats = require('../electron/features/skills/model-seats.cjs');
const { SkillsStore } = require('../electron/features/skills/store.cjs');
const { MAX_BYTES } = require('../electron/features/skills/files.cjs');
const { startupNote } = require('../electron/features/agents/handoff.cjs');

const resources = path.join(__dirname, '../resources/skills');
const body = '# Example skill\n\n## When this applies\n\nUse when the task fits.\n\n## What to do\n\n1. Read the task and follow the procedure.\n\n## Rules\n\n- Preserve existing behavior.\n\n## Done when\n\n- The checks pass and the result is reported.\n';
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
const team = '\n<!-- agentrix:team -->\n| Seat | Role | Duty | Outputs | Model | Launch |\n<!-- /agentrix:team -->\n';

test('routing renderer retains the pinned HEAD cells for template, project and SSH', () => {
  const text = fs.readFileSync(path.join(resources, 'model-routing/SKILL.md'), 'utf8');
  const { resolveTeam } = require('../electron/features/skills/team-roles.cjs');
  const { catalogRows, fixtures } = require('./fixtures/routing-cells.json');
  const entry = builtinMetadata(text, 'model-routing'), installed = { claude: true, codex: true };
  const catalog = modelSeats.catalog(installed, catalogRows), defaults = modelSeats.defaultsFor(installed, catalog, entry.seats);
  const render = config => {
    const { roles, effective: map } = resolveTeam(entry, config, defaults);
    const { leadAgent } = modelSeats.leadConfiguration(map, 'orchestrator', installed, catalog);
    return renderRoutingSkill(text, { roles, map, leadAgent, installed, catalog });
  };
  assert.equal(render({ roles: {} }), text);
  for (const { global, project, cells } of Object.values(fixtures)) {
    const table = render({ roles: { ...global, ...project } }).split('<!-- agentrix:team -->')[1].split('<!-- /agentrix:team -->')[0];
    const rendered = Object.fromEntries(table.trim().split(/\r?\n/).slice(2).map(line => {
      const columns = line.split('|').map(cell => cell.trim());
      return [columns[1], columns.slice(5, 7)];
    }));
    assert.deepEqual(rendered, cells);
  }
});

test('routing renderer moves enabled library roles into the team and frames custom text', () => {
  const text = fs.readFileSync(path.join(resources, 'model-routing/SKILL.md'), 'utf8');
  const { cleanConfig, resolveTeam } = require('../electron/features/skills/team-roles.cjs');
  const entry = builtinMetadata(text, 'model-routing'), installed = { claude: true, codex: true };
  const catalog = modelSeats.catalog(installed), defaults = modelSeats.defaultsFor(installed, catalog, entry.seats);
  const { config } = cleanConfig({ roles: {
    qa: { enabled: false },
    frontend: { enabled: true },
    'x-mobile': { from: 'frontend', name: 'Mobile', duty: 'Verify builds', outputs: 'Build notes' },
  } }, entry, catalog);
  const team = resolveTeam(entry, config, defaults);
  const rendered = renderRoutingSkill(text, { roles: team.roles, map: team.effective, leadAgent: 'claude', installed, catalog });
  const table = rendered.split('<!-- agentrix:team -->')[1].split('<!-- /agentrix:team -->')[0];
  const library = rendered.split('<!-- agentrix:library -->')[1].split('<!-- /agentrix:library -->')[0];
  assert.match(table, /Rows marked \(project role\) were written in this project\./);
  assert.match(table, /specialties: --seat frontend/);
  assert.match(table, /\| frontend \| Frontend .+\r?\n\| x-mobile \| Mobile \(project role, based on Frontend\) \| Verify builds \| Build notes \|/);
  assert.doesNotMatch(table, /\| qa \|/);
  assert.doesNotMatch(library, /\| frontend \|/);
  assert.match(library, /\| backend \|/);
});

function firstRunSkill({ builtinDir, dataDir }, trigger, extra = '') {
  put(path.join(builtinDir, 'code-standard', 'SKILL.md'), builtin('code-standard', { trigger: trigger === 'always' ? 'always' : 'auto' }) + extra);
  if (trigger === 'first-open') put(path.join(dataDir, 'skills.json'), JSON.stringify({ 'builtin:code-standard': { trigger } }));
}

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

test('rendered routing writes safe summaries and exposes role freshness changes', () => {
  const text = fs.readFileSync(path.join(resources, 'model-routing/SKILL.md'), 'utf8');
  const { frontMatter } = require('../electron/features/skills/front-matter.cjs');
  const { resolveTeam } = require('../electron/features/skills/team-roles.cjs');
  const entry = builtinMetadata(text, 'model-routing'), installed = { claude: true, codex: true };
  const catalog = modelSeats.catalog(installed), defaults = modelSeats.defaultsFor(installed, catalog, entry.seats);
  const { roles, effective: map } = resolveTeam(entry, { roles: {
    qa: { fresh: false }, designer: { fresh: true, model: 'evil:', effort: 'high' }, performance: { enabled: true },
    'x-mobile': { from: 'designer', name: 'Mobile Team', duty: 'Build mobile', outputs: '' },
  } }, defaults);
  const rendered = renderRoutingSkill(text, { roles, map, leadAgent: 'claude', installed, catalog });
  assert.match(rendered, /^summary: "/m);
  const summary = frontMatter(rendered).fields.summary;
  assert.match(summary, /evil:/);
  assert.match(summary, /x-mobile/);
  assert.doesNotMatch(summary, /Mobile Team/);
  assert.match(rendered, /\| designer \| Designer \(fresh instance\) \|/);
  assert.match(rendered, /\| qa \| QA \/ Tester \(may reuse an instance\) \|/);
  assert.match(rendered, /\| x-mobile \| Mobile Team \(project role, based on Designer\) \(fresh instance\) \|/);
  assert.doesNotMatch(rendered, /\| developer \|[^\r\n]+specialties:[^\r\n]+--seat performance/);
});

test('strict built-in format accepts all allowed triggers/requires, scalar quoting, BOM, CRLF and length boundaries', () => {
  for (const trigger of ['always', 'auto']) for (const requires of ['none', 'any-agent', 'codex', 'claude', 'both']) {
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

test('built-in routing metadata validates library authors, freshness, duties and table order', () => {
  const text = builtin('example', {
    seats: 'orchestrator, developer, reviewer',
    library: 'frontend, a11y',
    authors: 'developer, frontend',
    fresh: 'reviewer, a11y',
    duties: ['orchestrator', 'developer', 'reviewer', 'frontend', 'a11y'].map(id => id + '=\u89D2\u8272|\u804C\u8D23|\u8BF4\u660E|\u4EA7\u51FA').join('; '),
  }) + team + [
    '<!-- agentrix:library -->',
    '| Seat | Role | Duty | Outputs |',
    '| --- | --- | --- | --- |',
    '| frontend | Frontend | Build UI | UI changes |',
    '| a11y | Accessibility | Verify UI | Findings |',
    '<!-- /agentrix:library -->',
  ].join('\n');
  const { seats, library, authors, fresh, roles } = builtinMetadata(text, 'example');
  assert.deepEqual(seats, ['orchestrator', 'developer', 'reviewer']);
  assert.deepEqual(library, ['frontend', 'a11y']);
  assert.deepEqual(authors, ['developer', 'frontend']);
  assert.deepEqual(fresh, ['reviewer', 'a11y']);
  assert.deepEqual(roles.map(role => role.id), [...seats, ...library]);
  for (const malformed of [
    text.replace('library: frontend, a11y', 'library: developer, a11y'),
    text.replace('library: frontend, a11y', 'library: a11y, frontend'),
    text.replace('library: frontend, a11y', 'library: x-frontend, a11y'),
    text.replace('authors: developer, frontend', 'authors: developer, missing'),
    text.replace('fresh: reviewer, a11y', 'fresh: reviewer, missing'),
    text.replace(/^duties: .+\n/m, ''),
    text.replace(/; a11y=.+\n/, '\n'),
    text.replace('<!-- /agentrix:library -->', ''),
    text.replace('<!-- agentrix:library -->', '<!-- agentrix:library -->\n<!-- agentrix:library -->'),
    text.replace('| Seat | Role | Duty | Outputs |\n', '| Seat | Role | Duty | Model |\n'),
    text.replace(/^\| a11y \|.+\n/m, ''),
  ]) assert.throws(() => builtinMetadata(malformed, 'example'));
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
    assert.deepEqual(Object.keys(fields).filter(key => !['seats', 'fresh', 'roles', 'authors', 'library'].includes(key)), ['name', 'description', 'trigger', 'when', 'requires', 'title', 'summary']);
    assert.match(fields.description, /^Use (when|before|on|at|whenever)\b/, `${folder.name} description trigger`);
    for (const key of ['title', 'summary', 'when']) assert.match(english[fields[key]] || '', /[A-Za-z]/, `${folder.name} ${key} translation`);
  }
});

test('seat ids, fresh roles, and duties come from front matter and the team region stays outside fences', t => {
  const fields = { seats: 'captain, audit-2', fresh: 'audit-2', duties: 'audit-2=审查|独立审查|质量审查; captain=总指挥|任务调度|状态追踪|执行状态' };
  const source = builtin('example', fields) + team;
  const parsed = builtinMetadata(source, 'example');
  assert.deepEqual(parsed.seats, ['captain', 'audit-2']); assert.deepEqual(parsed.fresh, ['audit-2']);
  assert.deepEqual(parsed.roles, [{ id: 'captain', name: '总指挥', duty: '任务调度', detail: '状态追踪', outputs: '执行状态' },
    { id: 'audit-2', name: '审查', duty: '独立审查', detail: '质量审查', outputs: '' }]);
  for (const bad of [{ seats: 'core, core' }, { seats: 'Bad' }, { seats: 'a'.repeat(33) }, { seats: 'core', fresh: 'reviewer' },
    { fresh: 'visual' }, { ...fields, duties: 'captain=总指挥|调度|追踪' }, { ...fields, duties: fields.duties + '; captain=总指挥|调度|追踪' }]) {
    assert.throws(() => builtinMetadata(builtin('example', bad) + team, 'example'));
  }
  for (const invalid of [source.replace(team, ''), source + team, source.replace(team, '\n```markdown\n' + team + '```\n')]) {
    assert.throws(() => builtinMetadata(invalid, 'example'), /agentrix:team/);
  }
  const f = fixture(t, ({ builtinDir }) => put(path.join(builtinDir, 'example', 'SKILL.md'), source));
  assert.equal(f.store.seatsInfo().skill, 'builtin:example'); assert.equal(f.store.seatsInfo().lead, 'captain');
  const shipped = builtinMetadata(fs.readFileSync(path.join(resources, 'model-routing/SKILL.md'), 'utf8'), 'model-routing');
  const shared = require('./fixtures/team-seats.json');
  assert.deepEqual(shipped.seats, shared.seats); assert.deepEqual(shipped.roles.filter(role => shipped.seats.includes(role.id)), shared.roles);
  assert.deepEqual(shipped.fresh, ['reviewer', 'qa', 'a11y']);
});

test('shipped descriptions include trigger timing and system precedence without yielding', () => {
  const fields = name => builtinMetadata(fs.readFileSync(path.join(resources, name, 'SKILL.md'), 'utf8'), name);
  const routing = fields('model-routing'), standard = fields('code-standard'), ui = fields('ui-standard');
  assert.equal(routing.trigger, 'always');
  assert.match(routing.description, /^Use before any task while Agentrix runs the session in conductor mode; the lead session is the project.s conductor/);
  assert.doesNotMatch(routing.description, /unless the project has its own|yield/i);
  assert.equal(routing.when, '\u6bcf\u4e2a\u4efb\u52a1\u5f00\u59cb\u524d');
  assert.equal(standard.trigger, 'always');
  assert.match(standard.description, /^Use before every task/);
  assert.match(standard.description, /on its first run in a project/);
  assert.doesNotMatch(standard.description, /yield|has no code standard of its own/i);
  assert.equal(standard.when, '每个任务开始前生效；在项目里第一次运行时先审查现有代码并提出接入计划');
  assert.deepEqual([ui.trigger, ui.requires, ui.title], ['auto', 'none', '界面规范']);
  assert.match(ui.description, /^Use when designing, building, changing, debugging, restyling or reviewing any user interface, a small fix included/);
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
    for (const [index, requires] of ['none', 'any-agent', 'codex', 'claude', 'both'].entries()) put(path.join(builtinDir, requires, 'SKILL.md'), builtin(requires, { requires, trigger: ['auto', 'always'][index % 2] }));
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
  for (const [trigger, when] of Object.entries({ always: '每个任务开始前', auto: '描述匹配时' })) {
    const skill = store.setOptions(saved.id, { trigger });
    assert.equal(skill.when, when); assert.equal(skill.extends, null); assert.equal(skill.requires, null);
    assert.match(english[when], /[A-Za-z]/);
  }
  const legacy = store.setOptions(saved.id, { trigger: 'first-open' });
  assert.equal(legacy.trigger, 'auto'); assert.equal(legacy.firstOpenRun, true);
  assert.equal(store.setOptions(saved.id, { firstOpenRun: false }).firstOpenRun, false);
  for (const patch of [{ trigger: 'manual' }, { firstOpenRun: 'true' }]) assert.throws(() => store.setOptions(saved.id, patch), /技能选项无效/);
  store.setOptions('builtin:none', { trigger: 'always' });
  store.close(); const reopened = new SkillsStore(options); t.after(() => reopened.close());
  assert.equal(reopened.info(reopened.entry('builtin:none')).trigger, 'always');
});

for (const place of ['skills', '.claude/skills', '.codex/skills']) test(`same-name ${place} folders are moved by the watcher and the built-in still applies`, async t => {
  const { store, projects, changes } = fixture(t), project = projects[0], target = path.join(project.path, place);
  store.syncWatchers(); await store.watchers.get(target).poll();
  const before = start(store, project, 'before');
  const copy = path.join(target, 'code-standard');
  put(path.join(copy, 'asset.txt'), 'Recoverable contents.');
  await store.watchers.get(target).poll();
  const deadline = Date.now() + 5000;
  while (!store.info(store.entry('builtin:code-standard')).replaced.length) {
    assert.ok(Date.now() < deadline, 'watcher publishes replacement');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const info = store.info(store.entry('builtin:code-standard')), [record] = info.replaced;
  assert.equal(fs.existsSync(copy), false); assert.ok(changes.length);
  assert.equal(record.project, project.name); assert.equal(record.from, `${place}/code-standard`);
  assert.equal(fs.readFileSync(path.join(record.backup, 'asset.txt'), 'utf8'), 'Recoverable contents.');
  const after = store.delivery(project, false, 'after');
  assert.notEqual(after, before); assert.ok(after.skills.some(skill => skill.id === info.id));
  assert.ok(note(after).includes(normalized(info.path)));
  assert.equal('yielded' in after, false); assert.equal('yieldsTo' in info, false);
  assert.doesNotMatch(note(after), /This project has its own/);
});

test('instruction-file mentions never override built-ins and SSH paths are never scanned', t => {
  const { store, projects } = fixture(t, ({ projects }) => {
    for (const project of projects) {
      put(path.join(project.path, 'AGENTS.md'), 'Follow code-standard and model-routing.');
      put(path.join(project.path, 'CLAUDE.md'), 'Follow code-standard and model-routing.');
    }
    fs.mkdirSync(path.join(projects[2].path, '.codex/skills/code-standard'), { recursive: true });
  });
  for (const project of projects) {
    const delivery = store.delivery(project, project.kind === 'ssh', 'first');
    assert.ok(delivery.skills.some(skill => skill.id === 'builtin:code-standard'));
    assert.doesNotMatch(note(delivery), /This project has its own/);
  }
  assert.equal(fs.existsSync(path.join(projects[2].path, '.codex/skills/code-standard')), true);
  assert.ok(store.infos().every(skill => skill.replaced.length === 0));
});

test('project scan results are reused for deliveries and refreshes of unrelated roots', t => {
  const { store, projects, dataDir } = fixture(t);
  const reads = t.mock.method(fs, 'readFileSync', fs.readFileSync), scans = t.mock.method(fs, 'readdirSync', fs.readdirSync);
  const delivery = store.delivery(projects[0]);
  store.delivery(projects[1]); store.delivery(projects[0]);
  store.refresh(false, new Set([path.join(dataDir, 'skills')]));
  assert.equal(store.delivery(projects[0]), delivery);
  assert.equal(scans.mock.callCount(), 1, 'only the selected global root is scanned');
  assert.equal(reads.mock.callCount(), 0, 'instruction files and skill bodies are not reread');
});

test('newly added and moved projects replace copies before the first watcher scan', t => {
  const { root, store, projects, dataDir } = fixture(t);
  const project = { id: 'new', name: 'New project', path: path.join(root, 'new-project') };
  const copy = path.join(project.path, '.codex/skills/code-standard');
  fs.mkdirSync(copy, { recursive: true }); projects.push(project);
  const delivery = store.delivery(project, false, 'immediate');
  assert.equal(fs.existsSync(copy), false);
  assert.ok(delivery.skills.some(skill => skill.id === 'builtin:code-standard'));
  assert.equal(store.info(store.entry('builtin:code-standard')).replaced[0].project, 'New project');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json')) )['builtin:code-standard'].replaced.length, 1);
  assert.equal(store.options['builtin:code-standard']?.firstOpenedProjects, undefined);
  assert.equal(store.delivery(project, false, 'immediate'), delivery);
  project.path = path.join(root, 'moved-project'); fs.mkdirSync(project.path);
  assert.ok(note(store.delivery(project, false, 'after-move')).includes(firstInstruction(store.entry('builtin:code-standard').path)));
});

for (const trigger of ['always', 'first-open']) test(`${trigger} first run is claimed by an agent, never a shell or refresh`, t => {
  const { store, projects, dataDir, options } = fixture(t, dirs => firstRunSkill(dirs, trigger));
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
  assert.equal(store.info(store.entry(id)).trigger, trigger === 'first-open' ? 'auto' : 'always');
  assert.equal(store.info(store.entry(id)).firstOpenRun, trigger === 'first-open');
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
  const refresh = vm.runInNewContext('(' + main.slice(main.indexOf('function refreshSkillNotes()'), main.indexOf('// Workspace broadcasts')) + ')', {
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

for (const trigger of ['always', 'first-open']) test(`disabled ${trigger} skills are not recorded as run`, t => {
  const { store, projects } = fixture(t, dirs => {
    const { projects } = dirs;
    firstRunSkill(dirs, trigger);
    fs.mkdirSync(path.join(projects[0].path, 'skills/code-standard'), { recursive: true });
  });
  const id = 'builtin:code-standard', project = projects[0];
  assert.equal(fs.existsSync(path.join(project.path, 'skills/code-standard')), false);
  store.setOptions(id, { enabled: false }); start(store, project, 'disabled');
  assert.equal(store.options[id]?.firstOpenedProjects, undefined);
  store.setOptions(id, { enabled: true });
  assert.ok(note(start(store, project, 'enabled')).includes(firstInstruction(store.entry(id).path, trigger)));
  assert.equal(store.options[id].firstOpenedProjects[project.id], 'enabled');
});

for (const trigger of ['always', 'first-open']) test(`${trigger} skills omitted from an SSH bundle have not run`, t => {
  const { store, projects } = fixture(t, dirs => {
    const { builtinDir } = dirs;
    put(path.join(builtinDir, 'a-large', 'SKILL.md'), builtin('a-large') + 'x'.repeat(420 * 1024));
    firstRunSkill(dirs, trigger, 'x'.repeat(120 * 1024));
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
  const { store, projects, root } = fixture(t, dirs => firstRunSkill(dirs, trigger));
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
  context.endSkillSession(first); assert.equal(fs.existsSync(firstManifest), true);
  first.agent = 'claude'; context.startSkillSession(project, first, 2);
  assert.equal(first.sessionId, 'one'); assert.notEqual(first.skillSessionId, claimedSession);
  assert.equal(store.options[id].firstOpenedProjects[project.id], claimedSession);
  assert.doesNotMatch(fs.readFileSync(first.skillNoteFile, 'utf8'), /this is its first run/);
});

test('built-in routing runs before every task without claiming a first run', t => {
  const { store, projects } = fixture(t), id = 'builtin:model-routing';
  const first = start(store, projects[0], 'first');
  const routing = first.skills.find(skill => skill.id === id);
  assert.equal(routing.trigger, 'always');
  assert.ok(note(first).includes(alwaysInstruction(routing.path)));
  assert.equal(store.options[id]?.firstOpenedProjects, undefined);
});

test('always skills reuse a persisted first-open claim after a default change', t => {
  const { store, projects, options } = fixture(t, ({ builtinDir }) => put(path.join(builtinDir, 'code-standard', 'SKILL.md'), builtin('code-standard', { trigger: 'auto' })));
  const project = projects[0], id = 'builtin:code-standard', file = store.entry(id).path;
  store.setOptions(id, { firstOpenRun: true });
  start(store, project, 'first');
  store.close();
  put(file, builtin('code-standard', { trigger: 'always' }));
  const reopened = new SkillsStore(options); t.after(() => reopened.close());
  assert.ok(note(start(reopened, project, 'later')).includes(alwaysInstruction(file)));
  assert.ok(note(start(reopened, project, 'first')).includes(firstInstruction(file)));
  assert.equal(reopened.options[id].firstOpenedProjects[project.id], 'first');
});

test('project instruction files are never read for skill precedence, including unreadable and linked files', t => {
  const { store, projects, errors } = fixture(t), project = projects[0], id = 'builtin:code-standard';
  put(path.join(project.path, 'AGENTS.md'), 'code-standard ' + 'x'.repeat(MAX_BYTES));
  fs.mkdirSync(path.join(project.path, 'CLAUDE.md'));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (['AGENTS.md', 'CLAUDE.md'].includes(path.basename(String(file)))) throw new Error('Instruction files must not be read');
    return read(file, ...args);
  });
  store.refresh(); assert.equal(errors.length, 0);
  assert.ok(note(store.delivery(project, false, 'first')).includes(normalized(store.entry(id).path)));
});

test('project manifests and launch snapshots survive exits and restarts and are pruned only with their project', t => {
  const { store, projects, options, dataDir } = fixture(t), id = 'builtin:code-standard';
  const first = start(store, projects[0], 'first'), second = start(store, projects[1], 'second');
  store.invalidateDelivery(); store.endSession(projects[0].id, 'first');
  assert.equal(fs.existsSync(first.manifest), true); assert.equal(fs.existsSync(second.manifest), true);
  assert.equal(fs.existsSync(first.sessionManifest), true); assert.equal(fs.existsSync(`${first.sessionManifest}.json`), true);
  const removed = projects.shift(); store.syncWatchers();
  assert.equal(fs.existsSync(first.manifest), false); assert.equal(fs.existsSync(first.sessionManifest), false);
  assert.equal(fs.existsSync(`${first.sessionManifest}.json`), false);
  assert.equal(fs.existsSync(second.sessionManifest), true);
  assert.equal(store.options[id].firstOpenedProjects[removed.id], undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json'), 'utf8'))[id].firstOpenedProjects[removed.id], undefined);
  const keep = path.join(dataDir, 'skill-delivery', 'keep.md'); put(keep, 'unrelated');
  store.close(); const reopened = new SkillsStore(options); t.after(() => reopened.close());
  assert.equal(fs.existsSync(second.manifest), true); assert.equal(fs.existsSync(second.sessionManifest), true);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'unrelated');
  assert.equal(reopened.options[id].firstOpenedProjects[projects[0].id], 'second');
});
