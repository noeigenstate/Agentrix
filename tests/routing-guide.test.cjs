const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { guideMetadata } = require('../electron/features/routing/guide-format.cjs');
const { renderRoutingGuide } = require('../electron/features/routing/guide-render.cjs');
const { MAX_BYTES } = require('../electron/shared/front-matter.cjs');
const modelSeats = require('../electron/features/routing/model-seats.cjs');

const guideFile = path.join(__dirname, '../resources/routing/model-routing.md');
const body = ['# Example guide', '## When this applies', 'Use when the task fits.', '## What to do',
  '1. Read the task and follow the procedure.', '## Rules', '- Preserve existing behavior.',
  '## Done when', '- The checks pass and the result is reported.'].join('\n\n') + '\n';
const guide = (name = 'example', fields = {}) => Object.entries({ name,
  description: 'Use when the task needs it; follow a tested procedure.', trigger: 'auto', when: '描述匹配时生效', requires: 'none',
  title: '示例技能', summary: '按步骤处理任务。', ...fields })
  .map(([key, value]) => `${key}: ${value}`).join('\n').replace(/^/, '---\n') + '\n---\n\n' + body;
const team = '\n<!-- agentrix:team -->\n| Seat | Role | Duty | Outputs | Model | Launch |\n<!-- /agentrix:team -->\n';

test('routing renderer retains the pinned HEAD cells for template, project and SSH', () => {
  const text = fs.readFileSync(guideFile, 'utf8');
  const { resolveTeam } = require('../electron/features/routing/team-roles.cjs');
  const { catalogRows, fixtures } = require('./fixtures/routing-cells.json');
  const entry = guideMetadata(text, 'model-routing'), installed = { claude: true, codex: true };
  const catalog = modelSeats.catalog(installed, catalogRows), defaults = modelSeats.defaultsFor(installed, catalog, entry.seats);
  const render = config => {
    const { roles, effective: map } = resolveTeam(entry, config, defaults);
    const { leadAgent } = modelSeats.leadConfiguration(map, 'orchestrator', installed, catalog);
    return renderRoutingGuide(text, { roles, map, leadAgent, installed, catalog });
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
  const text = fs.readFileSync(guideFile, 'utf8');
  const { cleanConfig, resolveTeam } = require('../electron/features/routing/team-roles.cjs');
  const entry = guideMetadata(text, 'model-routing'), installed = { claude: true, codex: true };
  const catalog = modelSeats.catalog(installed), defaults = modelSeats.defaultsFor(installed, catalog, entry.seats);
  const { config } = cleanConfig({ roles: {
    qa: { enabled: false },
    frontend: { enabled: true },
    'x-mobile': { from: 'frontend', name: 'Mobile', duty: 'Verify builds', outputs: 'Build notes' },
  } }, entry, catalog);
  const team = resolveTeam(entry, config, defaults);
  const rendered = renderRoutingGuide(text, { roles: team.roles, map: team.effective, leadAgent: 'claude', installed, catalog });
  const table = rendered.split('<!-- agentrix:team -->')[1].split('<!-- /agentrix:team -->')[0];
  const library = rendered.split('<!-- agentrix:library -->')[1].split('<!-- /agentrix:library -->')[0];
  assert.match(table, /Rows marked \(project role\) were written in this project\./);
  assert.match(table, /specialties: seat frontend/);
  assert.match(table, /\| frontend \| Frontend .+\r?\n\| x-mobile \| Mobile \(project role, based on Frontend\) \| Verify builds \| Build notes \|/);
  assert.doesNotMatch(table, /\| qa \|/);
  assert.doesNotMatch(library, /\| frontend \|/);
  assert.match(library, /\| backend \|/);
});

test('rendered routing writes safe summaries and exposes role freshness changes', () => {
  const text = fs.readFileSync(guideFile, 'utf8');
  const { frontMatter } = require('../electron/shared/front-matter.cjs');
  const { resolveTeam } = require('../electron/features/routing/team-roles.cjs');
  const entry = guideMetadata(text, 'model-routing'), installed = { claude: true, codex: true };
  const catalog = modelSeats.catalog(installed), defaults = modelSeats.defaultsFor(installed, catalog, entry.seats);
  const { roles, effective: map } = resolveTeam(entry, { roles: {
    qa: { fresh: false }, designer: { fresh: true, model: 'evil:', effort: 'high' }, performance: { enabled: true },
    'x-mobile': { from: 'designer', name: 'Mobile Team', duty: 'Build mobile', outputs: '' },
  } }, defaults);
  const rendered = renderRoutingGuide(text, { roles, map, leadAgent: 'claude', installed, catalog });
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

test('strict routing guide format accepts all allowed triggers/requires, scalar quoting, BOM, CRLF and length boundaries', () => {
  for (const trigger of ['always', 'auto']) for (const requires of ['none', 'any-agent', 'codex', 'claude', 'both']) {
    const fields = guideMetadata(guide('example', { trigger, requires }), 'example');
    assert.equal(fields.trigger, trigger); assert.equal(fields.requires, requires);
    assert.deepEqual(Object.keys(fields), ['name', 'description', 'trigger', 'when', 'requires', 'title', 'summary']);
  }
  for (const timing of ['when', 'before', 'on', 'at', 'whenever']) {
    const description = `Use ${timing} a task needs it; follow the procedure.`;
    assert.equal(guideMetadata(guide('example', { description }), 'example').description, description);
  }
  const prefix = 'Use when ';
  const limits = guide('example', { title: '一二三四五六七八', summary: '中'.repeat(89) + '。', description: prefix + 'x'.repeat(2000 - prefix.length) });
  assert.doesNotThrow(() => guideMetadata(limits, 'example'));
  const quoted = guide('example', { summary: "'审查代码: 先报告问题。'", description: '"Use when reviewing code: report findings."' });
  assert.equal(guideMetadata('\uFEFF' + quoted.replace(/\n/g, '\r\n'), 'example').summary, '审查代码: 先报告问题。');
  const fenced = guide().replace('1. Read the task and follow the procedure.', '1. Read the example.\n\n````markdown\n## Example heading\n```\n## Still inside the example\n````');
  assert.doesNotThrow(() => guideMetadata(fenced, 'example'));
});

test('routing guide metadata validates library authors, freshness, duties and table order', () => {
  const text = guide('example', {
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
  const { seats, library, authors, fresh, roles } = guideMetadata(text, 'example');
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
  ]) assert.throws(() => guideMetadata(malformed, 'example'));
});

test('strict routing guide format rejects bad fields, limits, scalars and body sections', () => {
  const good = guide();
  const bad = {
    'missing front matter': body,
    'missing key': good.replace('requires: none\n', ''),
    'extra key': good.replace('requires: none', 'requires: none\nextra: nope'),
    'wrong order': good.replace('trigger: auto\nwhen: 描述匹配时生效', 'when: 描述匹配时生效\ntrigger: auto'),
    'old order': good.replace(/(description: [^\n]+\n)(trigger: [^\n]+\n)(when: [^\n]+\n)(requires: [^\n]+\n)(title: [^\n]+\n)(summary: [^\n]+\n)/, '$5$6$1$2$3$4'),
    'duplicate key': good.replace('requires: none', 'trigger: auto'),
    'mismatched filename': guide('another'),
    'non-kebab name': guide('bad_name'),
    'oversized name': guide('x'.repeat(121)),
    'short title': guide('example', { title: '规' }),
    'long title': guide('example', { title: '一二三四五六七八九' }),
    'English title': guide('example', { title: 'Example' }),
    'long summary': guide('example', { summary: '中'.repeat(91) }),
    'English summary': guide('example', { summary: 'Use a procedure.' }),
    'three-sentence summary': guide('example', { summary: '先审查。再修改。后总结。' }),
    'missing Use trigger': guide('example', { description: 'Follow a procedure.' }),
    'trigger after description': guide('example', { description: 'Follow a procedure. Use when reviewing code.' }),
    'wrong trigger case': guide('example', { description: 'use when reviewing code; follow the procedure.' }),
    'trigger without a word boundary': guide('example', { description: 'Use wheneverneeded; follow the procedure.' }),
    'trigger without a condition': guide('example', { description: 'Use when' }),
    'Chinese description': guide('example', { description: 'Use when reviewing code; 审查代码。' }),
    'long description': guide('example', { description: 'Use when ' + 'x'.repeat(2000) }),
    'bad trigger': guide('example', { trigger: 'sometimes' }),
    'English timing': guide('example', { when: 'Before a task.' }),
    'two-sentence timing': guide('example', { when: '先审查。再修改。' }),
    'bad requires': guide('example', { requires: 'either' }),
    'empty scalar': guide('example', { when: '' }),
    'multiline scalar': guide('example', { summary: '>\n  审查代码。' }),
    'quoted newline': guide('example', { summary: '"审查\\n代码。"' }),
    'quoted line separator': guide('example', { summary: '"审查\\u2028代码: 先报告。"' }),
    'unnecessary quotes': guide('example', { trigger: '"auto"' }),
    'unclosed quote': guide('example', { summary: "'审查代码。" }),
    'YAML comment': guide('example', { when: '描述匹配时生效 # comment' }),
    'unquoted colon': guide('example', { summary: '审查代码: 先报告问题。' }),
    'missing heading': good.replace('## Rules\n', ''),
    'wrong heading order': good.replace('## Rules', '## Placeholder').replace('## Done when', '## Rules').replace('## Placeholder', '## Done when'),
    'extra heading': good + '\n## Extra\nNo extra sections.\n',
    'indented extra heading': good + '\n  ## Extra\nNo extra sections.\n',
    'tabbed extra heading': good + '\n##\tExtra\nNo extra sections.\n',
    'extra title': good + '\n# Another title\n',
    'wrong title level': good.replace('# Example guide', '### Example guide'),
    'Chinese body': good.replace('Preserve existing behavior.', '保持行为不变。'),
    'unnumbered steps': good.replace('1. Read the task', 'Read the task'),
    'missing bullets': good.replace('- Preserve existing behavior.', 'Preserve existing behavior.'),
    'empty section': good.replace('- The checks pass and the result is reported.', ''),
    'unclosed fence': good + '\n```\nunfinished',
    NUL: good + '\0',
    'oversized file': good + 'x'.repeat(MAX_BYTES),
  };
  for (const [label, text] of Object.entries(bad)) assert.throws(() => guideMetadata(text, 'example'), undefined, label);
});

test('seat ids, fresh roles, and duties come from front matter and the team region stays outside fences', () => {
  const fields = { seats: 'captain, audit-2', fresh: 'audit-2', duties: 'audit-2=审查|独立审查|质量审查; captain=总指挥|任务调度|状态追踪|执行状态' };
  const source = guide('example', fields) + team;
  const parsed = guideMetadata(source, 'example');
  assert.deepEqual(parsed.seats, ['captain', 'audit-2']); assert.deepEqual(parsed.fresh, ['audit-2']);
  assert.deepEqual(parsed.roles, [{ id: 'captain', name: '总指挥', duty: '任务调度', detail: '状态追踪', outputs: '执行状态' },
    { id: 'audit-2', name: '审查', duty: '独立审查', detail: '质量审查', outputs: '' }]);
  for (const bad of [{ seats: 'core, core' }, { seats: 'Bad' }, { seats: 'a'.repeat(33) }, { seats: 'core', fresh: 'reviewer' },
    { fresh: 'visual' }, { ...fields, duties: 'captain=总指挥|调度|追踪' }, { ...fields, duties: fields.duties + '; captain=总指挥|调度|追踪' }]) {
    assert.throws(() => guideMetadata(guide('example', bad) + team, 'example'));
  }
  for (const invalid of [source.replace(team, ''), source + team, source.replace(team, '\n```markdown\n' + team + '```\n')]) {
    assert.throws(() => guideMetadata(invalid, 'example'), /agentrix:team/);
  }
  const shipped = guideMetadata(fs.readFileSync(guideFile, 'utf8'), 'model-routing');
  const shared = require('./fixtures/team-seats.json');
  assert.deepEqual(shipped.seats, shared.seats); assert.deepEqual(shipped.roles.filter(role => shipped.seats.includes(role.id)), shared.roles);
  assert.deepEqual(shipped.fresh, ['reviewer', 'qa', 'a11y']);
});

