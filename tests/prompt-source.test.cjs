const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PromptQueue, promptText, promptSummary } = require('../electron/prompt-queue.cjs');
const { ActionLog, claudeRecord, claudePrompt, codexRecord } = require('../electron/agent-actions.cjs');
const { ConversationLog, claudeConversation, codexConversation } = require('../electron/conversation.cjs');
const { CodexActivityReader } = require('../electron/codex-activity.cjs');
const { isLocalAgentCommand } = require('../electron/agent-commands.cjs');
const { WorkspaceStore } = require('../electron/state.cjs');
const { SubmissionTracker } = require('../electron/terminal-input.cjs');
const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs');

const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
function activityHarness(mode = 'codex') {
  let now = 2000, alerts = 0, arms = 0;
  const agent = mode.startsWith('claude') ? 'claude' : 'codex';
  const project = { id: 'project', name: 'Synthetic project', path: __dirname, kind: 'local', restore: {}, unread: 0, completionArmed: false, seenEvents: [] };
  const store = new WorkspaceStore(''); store.save = () => {}; store.projects = [project];
  const expectCompletion = store.expectCompletion.bind(store);
  store.expectCompletion = (...args) => { arms++; expectCompletion(...args); };
  const s = { terminalId: project.id, projectId: project.id, sessionId: 'session', sessionKey: 'key', status: 'running', codexActive: true, agent,
    activitySince: 1000, activityInputAt: 0, promptQueue: new PromptQueue(() => {}, { now: () => now }), actions: new ActionLog(), submissions: new SubmissionTracker(),
    gate: { input() {} }, nativeMessages: [], native: mode.endsWith('-native') ? { registry: { list: () => [] } } : null };
  const sessions = new Map([[s.terminalId, s]]);
  const context = vm.createContext({ s, project, sessions, store, ConversationLog, summarizeTask: promptSummary, promptText, isLocalAgentCommand,
    publishConversation() {}, broadcast() {}, scheduleState() {}, notifyCompletion() { alerts++; }, followClaude() {},
    memoryFolder: () => '', memoryDir: () => '', roundsOf: () => [], remember: async () => {}, scrubProjectSkills: async () => {},
    setTimeout: () => ({ unref() {} }), Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    findProject: () => project, randomUUID: require('node:crypto').randomUUID,
  });
  const start = main.indexOf('  s.conversation = new ConversationLog(');
  vm.runInContext(main.slice(start, main.indexOf('\n  sessions.set(id, s);', start)), context);
  vm.runInContext(main.slice(main.indexOf('function applyActivity('), main.indexOf('function onEvent(')), context);
  vm.runInContext(main.slice(main.indexOf('function onEvent('), main.indexOf('// The agent chosen on a new project')), context);
  vm.runInContext(main.slice(main.indexOf('function nativeSessionEvent('), main.indexOf('function startTerminal(')), context);
  const listeners = {};
  registerTerminalIpc({ handle() {}, listen: (name, fn) => { listeners[name] = fn; }, getSession: id => sessions.get(id), getProjectById: () => project,
    acknowledgeProject: id => store.acknowledge(id), expectCompletion: id => store.expectCompletion(id), scheduleState() {}, pollAfterSubmission() {},
    applyActivity: context.applyActivity, now: () => now });
  return { s, project, store, context, alerts: () => alerts, arms: () => arms, now: value => { now = value; },
    write: text => listeners['terminal:write'](s.terminalId, text) };
}

// Shapes from the CLIs, with synthetic content only.
const injected = [
  ['<task-notification><status>completed</status><summary>Background check</summary></task-notification> Read its output.'],
  ['<agent-message from="worker">[Subagent hand-back] Synthetic report.</agent-message>'],
  ['<teammate-message teammate_id="worker">Synthetic teammate update.</teammate-message>'],
  ['<teammate_message>Synthetic teammate update.</teammate_message>'],
  ['<system-reminder>Synthetic reminder.</system-reminder>'],
  ['<local-command-caveat>Synthetic caveat.</local-command-caveat>'],
  ['<local-command-stdout>Synthetic local output.</local-command-stdout>'],
  ['<local-command-stderr>Synthetic local error.</local-command-stderr>'],
  ['<environment_context><cwd>/synthetic</cwd></environment_context>'],
  ['# AGENTS.md instructions for /synthetic\n<INSTRUCTIONS>Synthetic rules.</INSTRUCTIONS>'],
  ['<user_instructions>Synthetic rules.</user_instructions>'],
  ['<user-prompt-submit-hook>Synthetic hook output.</user-prompt-submit-hook>'],
  ['<subagent_notification>Synthetic report.</subagent_notification>'],
  ['<tool_result>Synthetic result.</tool_result>'],
  ['[Subagent hand-back] Synthetic report.'],
  ['[Request interrupted by user]'],
  ['[Request interrupted by user for tool use]'],
  ['Synthetic metadata.', { isMeta: true }],
  ['Synthetic child prompt.', { isSidechain: true }],
  ['Synthetic compacted history.', { isCompactSummary: true }],
  ['Synthetic transcript-only notice.', { isVisibleInTranscriptOnly: true }],
  ['Synthetic peer update.', { origin: { kind: 'peer' }, promptSource: 'system', turnOrigin: 'peer' }],
  ['Synthetic notification.', { origin: { kind: 'task-notification' }, queueTranscriptOnly: true }],
  [[{ type: 'tool_result', tool_use_id: 'call', content: 'Synthetic result.' }, { type: 'text', text: 'Synthetic tool context.' }]],
];
const stamp = at => new Date(at).toISOString();
const claude = (content, at = 2000, extra = {}) => ({ type: 'user', uuid: `u-${at}`, timestamp: stamp(at), message: { content }, ...extra });
const codex = (content, at = 2000, extra = {}, modern = true) => ({ type: 'event_msg', timestamp: stamp(at), ...extra,
  payload: modern ? { type: 'item_completed', item: { type: 'UserMessage', id: `u-${at}`, content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, ...extra } }
    : { type: 'user_message', message: content, ...extra } });

test('both agents ignore every injected kind before it can start a prompt or replace the task', () => {
  for (const [content, extra = {}] of injected) {
    const actions = new ActionLog(), conversation = new ConversationLog(), queue = new PromptQueue();
    queue.start('Fix the synthetic button.', 1000, 'real'); queue.submit('Then update the tests.', true, 1100);
    const before = queue.list();
    claudeRecord(actions, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { file_path: 'sample.txt' } }] } });
    const record = claude(content, 2000, extra);
    assert.equal(claudePrompt(record), false);
    claudeRecord(actions, record); claudeConversation(conversation, record);
    assert.deepEqual(actions.list.map(item => item.id), ['call'], 'injection cannot reset the current round');
    assert.deepEqual(conversation.list, []);
    assert.equal(promptText(content, extra), null);
    if (typeof content === 'string' && !Object.keys(extra).length) {
      queue.start(content, 2000, 'injected'); queue.submit(content, true, 2000);
      assert.deepEqual(queue.list(), before, 'injection cannot consume a pending prompt');
    }
    const reader = new CodexActivityReader('/synthetic');
    reader.snapshot = { prompt: 'Fix the synthetic button.', state: 'working', turnId: 'turn', updatedAt: 1000 };
    for (const modern of [true, false]) {
      if (!modern && typeof content !== 'string') continue;
      const record = codex(content, 2000, extra, modern);
      codexConversation(conversation, record); reader.record(record);
      assert.deepEqual(conversation.list, []);
      assert.equal(reader.snapshot.prompt, 'Fix the synthetic button.');
      assert.equal(reader.snapshot.state, 'working'); assert.equal(reader.snapshot.updatedAt, 1000);
    }
  }
});

test('Claude queued notifications and hand-backs never consume a human queue item, including anonymous dequeues', () => {
  const log = new ConversationLog();
  const feed = (operation, content, at) => claudeConversation(log, { type: 'queue-operation', operation, content, timestamp: stamp(at) });
  for (const content of [injected[0][0], injected[1][0]]) {
    feed('enqueue', content, 1000); feed('enqueue', 'Human request.', 1100);
    assert.deepEqual(log.list.map(entry => entry.text), ['Human request.']);
    feed('dequeue', undefined, 1200);
    assert.deepEqual(log.list.map(entry => entry.text), ['Human request.']);
    feed('dequeue', undefined, 1300);
    assert.deepEqual(log.list.map(entry => entry.text), ['Human request.'], 'anonymous dequeues cannot identify the received command');
    claudeConversation(log, claude('Human request.', 1350));
    assert.deepEqual(log.list.map(entry => [entry.text, !!entry.queued]), [['Human request.', false]]);
    log.reset();
    claudeConversation(log, { type: 'attachment', timestamp: stamp(1400), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: content } });
    assert.deepEqual(log.list, []);
  }
  for (const extra of [{ origin: { kind: 'peer' } }, { commandMode: 'task-notification' }, { humanTurn: false }]) {
    claudeConversation(log, { type: 'attachment', attachment: { type: 'queued_command', prompt: 'Synthetic background text.', ...extra } });
    assert.deepEqual(log.list, []);
  }
  feed('enqueue', '[Image #1] Human\nrequest.', 1500); feed('remove', 'Human\nrequest.', 1600);
  assert.deepEqual(log.queue, [], 'normal queue matching retains its marker cleanup');
  assert.deepEqual(log.list.map(entry => [entry.text, entry.queued]), [['Human\nrequest.', false]], 'a named handoff retains its user receipt');
});

test('slash commands are shown as the command while their original wrapper remains available', () => {
  const original = '<command-name>/model</command-name>\n<command-message>model</command-message><command-args>synthetic</command-args>';
  for (const [feed, record] of [[claudeConversation, claude(original)], [codexConversation, codex(original)]]) {
    const log = new ConversationLog(); feed(log, record);
    assert.equal(log.list[0].text, '/model'); assert.equal(log.list[0].original, original);
    const queue = new PromptQueue(); queue.start(log.list[0].original, 2000);
    assert.equal(queue.list()[0].summary, '/model'); assert.equal(queue.list()[0].text, original);
  }
  assert.equal(promptSummary('/model'), '/model');
  const q = new PromptQueue(); q.start(original, 1000, 'command', true);
  assert.equal(q.task.summary, '/model'); assert.deepEqual(q.list(), []);
  q.start('Human request.', 1100); q.submit('Next request.', true, 1200);
  const before = q.list(); q.start(original, 1300, 'second-command', true);
  assert.deepEqual(q.list(), before); assert.equal(q.task.summary, 'Human request.');
});

test('request summaries drop tagged pastes, code, markup, attachments and paths, then stop at the first sentence or line', () => {
  const cases = [
    ['**修复按钮**。然后更新测试！', '修复按钮。'],
    ['Fix   the\tbutton. Then update tests!', 'Fix the button.'],
    ['检查按钮！还有别的问题？', '检查按钮！'],
    ['Does it work? Check again.', 'Does it work?'],
    ['First line\r\nSecond line.', 'First line'],
    ['<pasted_content id="1">Raw paste.\nMore paste.</pasted_content>\n解释这个问题。再补测试。', '解释这个问题。'],
    ['<context>Hidden context.</context> Explain the issue.', 'Explain the issue.'],
    ['<img src="/synthetic/screen.png" /> Explain the issue.', 'Explain the issue.'],
    ['<img src="/synthetic/screen.png"> Explain the issue.', 'Explain the issue.'],
    ['```js\nthrow Error("example");\n```\nExplain the failure.', 'Explain the failure.'],
    ['~~~js\nconst example = 1;\n~~~\nExplain the example.', 'Explain the example.'],
    ['[Image #1] C:\\synthetic\\screen.png 看一下布局。继续检查。', '看一下布局。'],
    ['![screen](/synthetic/screen.png) Explain the layout.', 'Explain the layout.'],
    ['[File #1] "C:\\synthetic folder\\sample.ts" Inspect src/sample.ts and /tmp/example.log before changing them. Then test.', 'Inspect and before changing them.'],
    ['[guide](https://example.test/guide) needs **updating**.', 'guide needs updating.'],
    ['Check https://example.test/guide. Then update it.', 'Check.'],
    ['<pasted_content id="1">Only a paste.</pasted_content>', '（粘贴的内容）'],
    ['[Pasted text #1 +4 lines]', '（粘贴的内容）'],
    ['[Image #1]', '（图片）'],
    ['/synthetic/screen.png', '（图片）'],
    ['/synthetic/screen.png.', '（图片）'],
    ['```js\nconst example = 1;\n```', '（代码）'],
    ['[Attachment #1] /synthetic/sample.pdf', '（附件）'],
  ];
  for (const [original, expected] of cases) assert.equal(promptSummary(original), expected, original);
  assert.equal(promptSummary('长'.repeat(70)), '长'.repeat(59) + '…');
  assert.equal([...promptSummary('😀'.repeat(70))].length, 60);
  assert.equal([...promptSummary('A long synthetic request without a sentence ending '.repeat(3))].length, 60);
  assert.equal([...promptSummary('/' + 'command'.repeat(12))].length, 60);
  for (const content of [[{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }], [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]]) {
    assert.equal(promptSummary(promptText(content)), '（图片）');
  }
  const original = '<pasted_content>long paste</pasted_content>\n' + 'Request details '.repeat(50);
  const q = new PromptQueue(); q.submit(original, true, 1000);
  assert.equal(q.list()[0].text, original); assert.equal([...q.list()[0].summary].length, 60);
});

test('spoken task names keep the short Chinese and English limits while cards retain their longer sentence', () => {
  const options = { spoken: true };
  assert.equal(promptSummary('给登录页加上验证码。然后跑一下测试', options), '给登录页加上验证码');
  assert.equal(promptSummary('Add a captcha to the login page. Then run the tests.', options), 'Add a captcha to the login page');
  assert.equal(promptSummary('<task-notification>Background command completed</task-notification>', options), '');
  const chinese = '把设置对话框右上角的关闭按钮删掉，并且更新所有相关的测试脚本和文档说明';
  const english = 'refactor the voice input so that it works in every terminal and every split view we have';
  assert.equal(promptSummary(chinese, options), '把设置对话框右上角的关闭按钮删掉，并且更新所有相关的测试…');
  assert.equal(promptSummary(english, options), 'refactor the voice input so that it works in every terminal and…');
  assert.equal(promptSummary(chinese), chinese);
  assert.equal([...promptSummary(english)].length, 60);
  assert.equal(promptSummary('修复 `useProjectReorder` 里拖动结束的抖动 https://example.com/issue/1', options), '修复 里拖动结束的抖动');
  assert.equal(promptSummary('看看 C:\\Users\\me\\app\\main.cjs 这个文件的报错', options), '看看 这个文件的报错');
  assert.equal(promptSummary('```js\nconsole.log(1)\n```\n解释这段代码', options), '解释这段代码');
  assert.equal(promptSummary('修复按钮；然后测试', options), '修复按钮');
  assert.equal(promptSummary('Fix version 1.2 first. Then test.', options), 'Fix version 1.2 first');
  assert.equal(promptSummary('长'.repeat(20), { spoken: true, maxChars: 8 }), '长'.repeat(8) + '…');
  assert.equal(promptSummary('one two three four', { spoken: true, maxWords: 3 }), 'one two three…');
});

test('bare follow-ups retain the previous task and hover through completion but keep their own queue text', () => {
  const followUps = ['继续', '接着', '继续吧', '继续执行', '好', '好的', '可以', '行', '嗯', '是', '是的', '对',
    'go on', 'continue', 'keep going', 'ok', 'okay', 'yes', 'y', 'proceed'];
  for (const word of followUps) for (const prompt of [word, ` ${word.toUpperCase()}。 `]) {
    assert.equal(promptSummary(prompt), '', prompt); assert.equal(promptSummary(prompt, { spoken: true }), '', prompt);
    for (const delivered of [false, true]) {
      const q = new PromptQueue(); q.start('Fix the synthetic button.', 1000);
      if (delivered) q.reply({ at: 1500, text: '【交付】\n问题：Synthetic button fixed.' });
      q.finish(2000);
      const { summary, title } = q.task;
      q.submit(prompt, true, 2100);
      assert.equal(q.list()[0].text, prompt); assert.equal(q.list()[0].summary, prompt.trim());
      q.start(prompt, 2200);
      assert.equal(q.task.summary, summary); assert.equal(q.task.title, title);
      assert.equal(q.list()[0].summary, prompt.trim());
      q.finish(2500);
      assert.equal(q.task.summary, summary); assert.equal(q.task.title, title);
      q.start(prompt, 2600); q.reply({ at: 2700, text: '【交付】\n优化：New delivery.' }); q.finish(2800);
      assert.equal(q.task.summary, 'New delivery.');
    }
  }
  for (const value of ['  ', null, undefined]) assert.equal(promptSummary(value, { spoken: true }), '');
  for (const prompt of ['继续修复按钮。', 'Continue fixing the button.', 'OK, fix the button.']) assert.equal(promptSummary(prompt), prompt);
  const q = new PromptQueue(); q.start('继续', 1000); q.finish(2000);
  assert.equal(q.task.summary, ''); assert.equal(q.task.title, '');
});

test('completion uses only the last reply of its round and accepts a final reply read after the end', () => {
  const request = 'Fix the synthetic button. Then add tests.';
  for (const label of ['问题', '优化']) for (const late of [false, true]) {
    const q = new PromptQueue(); q.start(request, 1000);
    const reply = `Notes.\n【交付】\n${label}：**按钮现在可以正常点击**。其他细节。\n验证：Synthetic tests passed.`;
    if (late) q.finish(2000);
    q.reply({ at: 1900, text: reply });
    if (!late) { assert.equal(q.task.summary, 'Fix the synthetic button.'); q.finish(2000); }
    assert.deepEqual(q.list(), []); assert.equal(q.task.summary, '按钮现在可以正常点击。'); assert.equal(q.task.title, reply);
    q.finish(2150);
    q.reply({ at: 2100, text: '【交付】\n问题：Background output.' });
    assert.equal(q.task.summary, '按钮现在可以正常点击。', 'background replies cannot replace completed work');
    q.start('Next request.', 2200); q.reply({ at: 1900, text: reply }); q.finish(2400);
    assert.equal(q.task.summary, 'Next request.');
  }
  const q = new PromptQueue(); q.start(request, 1000);
  q.reply({ at: 1500, text: '【交付】\n问题：An earlier reply.' }); q.reply({ at: 1900, text: 'The actual final reply has no delivery block.' }); q.finish(2000);
  assert.equal(q.task.summary, 'Fix the synthetic button.'); assert.equal(q.task.title, request);
  const latePrompt = new PromptQueue(); latePrompt.reply({ at: 1500, text: '【交付】\n优化：Synthetic improvement.' }); latePrompt.finish(2000); latePrompt.start(request, 1000);
  assert.equal(latePrompt.task.summary, 'Synthetic improvement.'); assert.deepEqual(latePrompt.list(), []);
});

test('a Claude reply with several text blocks supplies its whole delivery', () => {
  const q = new PromptQueue(); q.start('Synthetic request.', 1000);
  const log = new ConversationLog(({ entry }) => { if (entry?.role === 'assistant') q.reply(entry); });
  claudeConversation(log, { type: 'assistant', uuid: 'reply', timestamp: stamp(1500), message: { content: [
    { type: 'text', text: '【交付】\n问题：Synthetic fix.' }, { type: 'text', text: 'Additional checks passed.' },
  ] } });
  q.finish(2000); assert.equal(q.task.summary, 'Synthetic fix.');
  assert.equal(q.task.title, '【交付】\n问题：Synthetic fix.\nAdditional checks passed.');
});

test('real main-process conversation callbacks ignore injections without rearming acknowledged completion', () => {
  for (const mode of ['claude', 'codex', 'codex-native']) {
    const h = activityHarness(mode), { s, project, context } = h, { agent } = s;
    const feed = agent === 'claude' ? record => claudeConversation(s.conversation, record) : record => codexConversation(s.conversation, record);
    if (agent === 'claude') context.claudeActivity(project, s, { state: 'working', sessionId: 'session', eventId: 'session:input', prompt: 'Human request.' });
    feed(agent === 'claude' ? claude('Human request.') : codex('Human request.'));
    assert.equal(h.arms(), 1);
    const reply = '【交付】\n问题：Synthetic completion.\n验证：Synthetic checks passed.';
    feed(agent === 'claude' ? { type: 'assistant', timestamp: stamp(2400), uuid: 'reply', message: { content: [{ type: 'text', text: reply }] } }
      : { type: 'event_msg', timestamp: stamp(2400), payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'reply', content: [{ type: 'text', text: reply }] } } });
    context.applyActivity(project, s, { state: 'complete', threadId: 'thread', turnId: 'turn', updatedAt: 2500 });
    if (mode === 'codex') s.promptQueue.finish(2500);
    assert.equal(h.alerts(), 1); assert.equal(project.completionArmed, false);
    h.store.acknowledge(project.id);
    for (const [content, extra = {}] of injected) feed(agent === 'claude' ? claude(content, 3000, extra) : codex(content, 3000, extra));
    assert.equal(h.arms(), 1); assert.equal(project.completionArmed, false); assert.deepEqual(s.promptQueue.list(), []);
    assert.equal(s.promptQueue.task.summary, 'Synthetic completion.'); assert.equal(s.promptQueue.task.title, reply);
    context.applyActivity(project, s, { state: 'complete', threadId: 'thread', turnId: 'background', updatedAt: 3500, prompt: injected[1][0] });
    assert.equal(h.alerts(), 1); assert.equal(s.promptQueue.task.summary, 'Synthetic completion.');
    feed(agent === 'claude' ? claude('<command-name>/model</command-name>', 4000) : codex('/model', 4000));
    assert.equal(s.promptQueue.task.summary, '/model'); assert.deepEqual(s.promptQueue.list(), []);
    assert.equal(h.arms(), 1); assert.equal(project.completionArmed, false, 'local slash commands cannot arm a model round');
  }
});

test('Claude queue receipts and withdrawals update activity without arming completion from history or callbacks', () => {
  const h = activityHarness('claude'), { s, project, context } = h;
  context.claudeActivity(project, s, { state: 'working', sessionId: 'session', eventId: 'session:input', prompt: 'Initial work.' });
  claudeConversation(s.conversation, claude('Initial work.', 2000));
  s.promptQueue.submit('Next work.', true, 2100);
  const queue = (operation, at) => claudeConversation(s.conversation, { type: 'queue-operation', operation, timestamp: stamp(at), content: 'Next work.' });
  s.promptQueue.submit('Historical work.', true, 2100);
  claudeConversation(s.conversation, { type: 'queue-operation', operation: 'enqueue', timestamp: stamp(1100), content: 'Historical work.' });
  claudeConversation(s.conversation, { type: 'queue-operation', operation: 'popAll', timestamp: stamp(1200), content: 'Historical work.' });
  assert.ok(s.promptQueue.list().some(item => item.text === 'Historical work.'));
  s.promptQueue.cancel('Historical work.', 2150);
  queue('enqueue', 2200); queue('popAll', 2300);
  assert.deepEqual(s.promptQueue.list().map(item => item.text), ['Initial work.']);
  assert.equal(h.arms(), 1);
  context.applyActivity(project, s, { state: 'complete', threadId: 'thread', turnId: 'turn', updatedAt: 2500 });
  h.store.acknowledge(project.id);
  queue('enqueue', 2600); claudeConversation(s.conversation, claude('Next work.', 2700));
  assert.equal(s.conversation.list.filter(entry => entry.queued && !entry.cancelled).length, 0);
  context.applyActivity(project, s, { state: 'complete', threadId: 'thread', turnId: 'background', updatedAt: 3000 });
  assert.equal(h.arms(), 1); assert.equal(h.alerts(), 1); assert.equal(project.unread, 0);
});

test('main keeps the short lastTask and long card task across bare follow-ups in terminal and managed sessions', () => {
  const requests = [
    ['把设置对话框右上角的关闭按钮删掉，并且更新所有相关的测试脚本和文档说明', '把设置对话框右上角的关闭按钮删掉，并且更新所有相关的测试…'],
    ['refactor the voice input so that it works in every terminal and every split view we have', 'refactor the voice input so that it works in every terminal and…'],
  ];
  for (const mode of ['codex', 'claude', 'codex-native', 'claude-native']) for (const [request, spoken] of requests) {
    const h = activityHarness(mode), { s, project, context } = h;
    const cardSummary = promptSummary(request);
    const managed = mode === 'claude-native';
    if (managed) s.nativeMode = 'claude-sdk';
    const prompt = (text, at) => {
      h.now(at);
      if (managed) context.nativeSessionEvent(s.terminalId, s.sessionId, { type: 'managed-prompt', text });
      else {
        (s.agent === 'claude' ? claudeConversation : codexConversation)(s.conversation, s.agent === 'claude' ? claude(text, at) : codex(text, at));
        context.applyActivity(project, s, { state: 'working', threadId: 'thread', updatedAt: at, prompt: text });
      }
    };
    prompt(request, 2000);
    assert.equal(s.lastTask, spoken);
    assert.equal(s.lastTaskTitle, request); assert.equal(s.lastTaskSummary, cardSummary); assert.equal(s.promptQueue.task.summary, cardSummary);
    s.promptQueue.finish(2100);
    for (const [index, continuation] of ['继续', 'continue', 'OK'].entries()) {
      prompt(continuation, 2200 + index * 200);
      assert.equal(s.lastTask, spoken); assert.equal(s.lastTaskTitle, request);
      assert.equal(s.promptQueue.task.summary, cardSummary); assert.equal(s.promptQueue.task.title, request);
      s.promptQueue.finish(2300 + index * 200);
    }
    Object.assign(context, { terminalIds: () => [s.terminalId], shownTerminalIds: () => [s.terminalId], getBranch: () => '', localShell: () => ({ kind: 'powershell' }),
      t: text => text, briefAction: value => value, desktopGlassBackend: null, desktopGlassActive: false, desktopGlassWindow: false,
      startupErrors: new Map(), process: { platform: 'win32', env: { AGENTRIX_DATA_DIR: 'synthetic' } }, app: { getVersion: () => '0.0.0' } });
    vm.runInContext(main.slice(main.indexOf('function publicState('), main.indexOf('function terminalIds(')), context);
    const card = () => context.publicState().projects[0].terminals[0];
    assert.equal(card().task, cardSummary); assert.equal(card().taskTitle, request);
    s.promptQueue.reset();
    assert.equal(card().task, cardSummary, 'the snapshot fallback also uses the longer card sentence');
    assert.equal(card().taskTitle, request);
  }
});

test('native input and Claude hooks retain explicit machine provenance before creating tasks or arming completion', () => {
  const reset = require('./fixtures/claude-usage-reset.json').records[0].content;
  for (const mode of ['claude-native', 'codex-native']) {
    const h = activityHarness(mode), { s, project, context } = h;
    if (mode === 'claude-native') s.nativeMode = 'claude-sdk';
    for (const [text, flags] of [[reset, {}], ['Neutral automatic continuation.', { isMeta: true }], ['Neutral automatic continuation.', { origin: { kind: 'auto-continuation' }, promptSource: 'system' }]]) {
      context.nativeSessionEvent(s.terminalId, s.sessionId, { type: 'managed-prompt', text, ...flags });
      if (mode === 'codex-native') context.nativeSessionEvent(s.terminalId, s.sessionId, { method: 'item/completed', params: { item: { type: 'userMessage', id: `machine-${text.length}`, content: [{ type: 'text', text }], ...flags } } });
      else context.claudeActivity(project, s, { state: 'working', sessionId: 'session', eventId: `session:machine-${text.length}`, prompt: text, ...flags });
    }
    assert.deepEqual(s.conversation.list, []);
    assert.deepEqual(s.promptQueue.list(), []);
    assert.equal(s.lastTask, undefined); assert.equal(s.lastTaskTitle, undefined);
    assert.equal(h.arms(), 0); assert.equal(h.alerts(), 0);
  }
});

test('completion-smoke records defer the alert across queued work, batched reads, early notify and a late received prompt', async t => {
  const { monitorActivity } = require('../electron/codex-activity.cjs');
  for (const order of ['incremental', 'batched', 'late-prompt']) for (const notifyFirst of [false, true]) {
    const h = activityHarness(), { s, project, store, context } = h;
    Object.assign(context, { codexConversation, codexRecord, event: { cwd: project.path }, describeActions() {}, noteSettings() {} });
    const start = main.indexOf('    const onRecord = record => {', main.indexOf('function onEvent('));
    const onRecord = vm.runInContext(main.slice(start, main.indexOf('    const remoteStatus =', start)) + '\nonRecord;', context);
    const reader = new CodexActivityReader(project.path, undefined, s.activitySince, { onRecord });
    reader.snapshot = { threadId: 'parent', turnId: null, state: 'unknown', updatedAt: 0 };
    const pending = [], errors = [];
    const poll = async () => { await s.activityMonitor.poll(); assert.deepEqual(errors, []); };
    s.activityMonitor = monitorActivity(async () => {
      try { for (const record of pending.splice(0)) reader.record(record); } catch (error) { errors.push(error); throw error; }
      return { ...reader.snapshot };
    }, snapshot => context.applyActivity(project, s, snapshot));
    t.after(() => s.activityMonitor.stop());
    const event = (type, turn, at) => ({ type: 'event_msg', timestamp: stamp(at), payload: { type, turn_id: turn } });
    const notify = threadId => context.onEvent({ type: 'turn-complete', projectId: s.terminalId, sessionKey: s.sessionKey, threadId });
    notify('child'); await poll();
    assert.equal(project.unread, 0);
    h.write('first instruction\r');
    pending.push({ type: 'session_meta', payload: { id: 'parent', cwd: project.path, source: 'cli' } }, event('task_started', 'first', 2100), codex('first instruction', 2100, {}, false));
    if (order !== 'batched') await poll();
    notify('child'); await poll();
    assert.equal(project.unread, 0); assert.equal(s.codexActivity, 'working');
    pending.push({ type: 'response_item', timestamp: stamp(2150), payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: 'text(await tools.exec_command({cmd:"npm test"}))' } },
      { type: 'response_item', timestamp: stamp(2160), payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: [] } },
      { type: 'response_item', timestamp: stamp(2170), payload: { type: 'custom_tool_call', call_id: 'call-2', name: 'exec', input: 'text(await tools.exec_command({cmd:"apply_patch\\n*** Begin Patch\\n*** Update File: src/login.ts\\n*** End Patch"}))' } });
    if (order === 'incremental') await poll();
    h.now(2200); h.write('给登录页加上验证码。然后跑一下测试\r');
    pending.push({ type: 'turn_context', timestamp: stamp(2210), payload: { cwd: project.path, model: 'gpt-6.1-sol', effort: 'high' } },
      { type: 'event_msg', timestamp: stamp(2220), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 320000, cached_input_tokens: 290000, output_tokens: 4200, total_tokens: 324200 }, model_context_window: 828400 } } },
      { type: 'event_msg', timestamp: stamp(2250), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 400000, cached_input_tokens: 360000, output_tokens: 5000, total_tokens: 405000 }, model_context_window: 828400 } } });
    const received = codex('给登录页加上验证码。然后跑一下测试', 2300, {}, false);
    if (order !== 'late-prompt') pending.push(received);
    if (order === 'incremental') {
      await poll();
      assert.deepEqual(s.promptQueue.list().map(item => item.state), ['working', 'working']);
      assert.equal(s.activityPromptAt, 2300);
    }
    h.now(2400); h.write('稍后补上文档\r');
    assert.equal(project.completionArmed, true);
    pending.push(event('task_complete', 'first', 2500));
    if (notifyFirst) { notify('parent'); await poll(); } else { await poll(); notify('parent'); await poll(); }
    assert.equal(project.unread, 0, `${order}, notifyFirst=${notifyFirst}`);
    assert.equal(h.alerts(), 0); assert.equal(s.codexActivity, 'working'); assert.equal(project.completionArmed, true);
    assert.equal(s.lastCompletedAt, undefined); assert.deepEqual(project.seenEvents, []);
    assert.equal(s.activityPromptAt, order === 'incremental' ? 2300 : 2100);
    if (order === 'late-prompt') { pending.push(received); await poll(); }
    assert.deepEqual(s.promptQueue.list().map(item => item.text), ['稍后补上文档']);
    const watermark = s.activityPromptAt, arms = h.arms();
    pending.push(received, codex('/model', 2600, {}, false), codex(injected[0][0], 2700, {}, false));
    await poll(); notify('parent'); notify('child'); await poll();
    assert.equal(s.activityPromptAt, watermark); assert.equal(h.arms(), arms);
    assert.equal(project.unread, 0); assert.equal(h.alerts(), 0);
    h.now(3000);
    pending.push(event('task_started', 'second', 3000), codex('稍后补上文档', 3100, {}, false), event('task_complete', 'second', 3500));
    await poll();
    assert.equal(s.codexActivity, 'complete'); assert.equal(project.unread, 1); assert.equal(h.alerts(), 1);
    assert.deepEqual(project.seenEvents, ['parent:second']);
    store.acknowledge(project.id); notify('parent'); await poll();
    assert.equal(project.unread, 0); assert.equal(h.alerts(), 1);
  }
});
