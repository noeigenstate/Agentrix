// Guards for electron/features/agents/BOUNDARY.md (Activity pane) that no behaviour test covers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// The pane only observes. Owner-authorized automatic resets are admitted by a
// separate main-process action, never by rendering a quota bar.
test('the pane never acts on its own: one /usage after the countdown, read-only account calls, no completion or editor controls', () => {
  const pane = read('src/features/agents/ResetQuota.tsx');
  assert.equal(pane.match(/\bsendToAgent\(/g).length, 1, 'one place types into the agent');
  assert.equal(pane.match(/new CustomEvent\('agentrix:command'/g).length, 1, 'one command event');
  assert.match(pane, /const command = '\/usage';/, 'and what it types is /usage');
  assert.deepEqual(pane.match(/\brun\(\)/g), ['run()'], 'which only the countdown starts');
  assert.match(pane, /if \(count === 0\) \{[^}]*void run\(\);/, 'when it reaches zero');
  assert.doesNotMatch(pane, /window\.agentrix\b|\bipcRenderer\b/, 'the pane calls no main-process action');
  for (const file of ['src/features/agents/ActivityPane.tsx', 'src/features/agents/ResetQuota.tsx', 'src/features/agents/ResetCountdown.tsx'])
    assert.doesNotMatch(read(file), /vs ?code|code\.cmd|openInEditor|markComplete|mark-complete|完成项目|标记完成/i, `${file} has no manual completion or editor launch control`);
  // Codex only reads identity (without refresh) and limits; Claude's usage is one GET.
  const source = read('electron/features/agents/codex-account-usage.cjs');
  const codex = source.slice(source.indexOf('function readCodexAccount('), source.indexOf('// Scope only to'));
  assert.deepEqual([...new Set([...codex.matchAll(/method: '([^']+)'/g)].map(match => match[1]))].sort(), ['account/rateLimits/read', 'account/read', 'initialize', 'initialized']);
  assert.match(codex, /method: 'account\/read', params: \{ refreshToken: false \}/);
  assert.doesNotMatch(codex, /rateLimitResetCredit\/consume/);
  const action = source.slice(source.indexOf('async function consumeCodexResetCredit('), source.indexOf('// Use a native executable'));
  assert.equal((action.match(/rpc\.request\('account\/rateLimitResetCredit\/consume'/g) || []).length, 1);
  const claude = read('electron/features/agents/claude-account-usage.cjs');
  assert.deepEqual([...claude.matchAll(/\bfetch\(([^,]+), \{ method: '([A-Z]+)'/g)].map(match => match.slice(1)), [['USAGE_URL', 'GET']]);
  assert.doesNotMatch(claude, /writeFile|oauth\/token|refresh_token/, 'never renews or writes credentials');
});

// A sub-agent's view is the owner's to open and its conversation only reads: nothing opens one by itself, nothing in it writes to a terminal,
// and the owner's word for the agent leaves through two main-process calls only.
test('a sub-agent view opens only on the owner’s click on a row, reads the sub-agent’s record and speaks to it through the main process only', () => {
  const walk = dir => fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
  const callers = walk('src').filter(file => /\.tsx?$/.test(file) && /\b(openSplit|toggleSplit)\(/.test(read(file)));
  assert.deepEqual(callers, ['src/features/agents/AgentCalls.tsx', 'src/features/agents/subagent-splits.ts'], 'only the list’s row and the store itself');
  const pane = read('src/features/agents/AgentCalls.tsx');
  assert.equal(pane.match(/\btoggleSplit\(/g).length, 1);
  assert.match(pane, /onClick=\{\(\) => toggleSplit\(terminalId, item\.id\)\}/, 'and it is the row button’s click');
  assert.doesNotMatch(read('src/features/terminal/ProjectTerminals.tsx'), /\b(openSplit|toggleSplit)\(/, 'the grid shows the views, it never opens one');
  const code = file => read(`src/features/agents/${file}`).replace(/\/\/.*$/gm, ''), view = ['SubagentPane.tsx', 'SubagentInput.tsx', 'subagent-splits.ts'].map(code).join('\n');
  assert.doesNotMatch(view, /writeTerminal|writeApproval|answerTerminal|resizeTerminal|startTerminal|closeTerminal|restartTerminal|sendToAgent|readClipboard|\.copy\(/, 'no write to a terminal, no input, no clipboard');
  assert.deepEqual([...view.matchAll(/window\.agentrix\.?(\w*)/g)].map(match => match[1]).sort(), ['', 'interveneAgent', 'stopAgent'], 'the bridge is handed to followFeed whole; the input only intervenes or stops');
  assert.deepEqual([...new Set([...view.matchAll(/bridge\.(\w+)/g)].map(match => match[1]))].sort(), ['onSubagentFeed', 'subagentFeed'], 'whose only calls are the two feed ones');
  assert.doesNotMatch(code('SubagentPane.tsx'), /<textarea|<input|contentEditable|interveneAgent|stopAgent/, 'the view itself takes no typing; its input is SubagentInput');
  assert.equal(code('SubagentInput.tsx').match(/<textarea/g).length, 1, 'one text box, for the owner’s word to the agent');
});

// The API card shows state and changes nothing; a word for a sub-agent goes to the worker, so the relay into the planner's input is gone.
test('the API usage card only reads the main process, and the parent relay can no longer type into a terminal', () => {
  const code = file => read(file).replace(/\/\/.*$/gm, '');
  const card = code('src/features/agents/ApiUsage.tsx');
  assert.deepEqual([...new Set([...card.matchAll(/\bbridge\.(\w+)\(/g)].map(match => match[1]))], ['usage'], 'its only bridge call is the usage read');
  assert.doesNotMatch(card, /sendToAgent|writeTerminal|setSettings|keySave|keyClear|\.answer\(|\.interrupt\(|\.send\(|\.start\(/, 'no write, no setting, no key, no answer');
  assert.match(read('src/features/agents/ActivityPane.tsx'), /<ApiUsage terminal=\{terminal\} projectId=\{projectId\} \/>/, 'and the pane shows it');
  assert.equal(fs.existsSync(path.join(__dirname, '../src/features/agents/parent-relay.ts')), false);
});

// The left bar's Agent tab shows the called models without the files module knowing the agents module: the node and the running count come from the agents module and the app only passes them.
test('the files module imports nothing from the agents module: the Agent tab gets its list as a node and a count from the app', () => {
  const code = file => read(file).replace(/\/\/.*$/gm, '');
  const walk = dir => fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(dir + '/' + entry.name) : [dir + '/' + entry.name]);
  assert.deepEqual(walk('src/features/files').filter(file => /\.tsx?$/.test(file) && /from '\.\.\/agents\//.test(code(file))), [], 'no file of the files module reaches into agents');
  const explorer = code('src/features/files/ProjectExplorer.tsx');
  assert.match(explorer, /agentPanel: ReactNode; agentRunning: number;/, 'the tab takes a ready node and a count');
  assert.match(explorer, /\{tab === 'agent' && !collapsed && <div className="explorer-agent">\{agentPanel\}<\/div>\}/);
  assert.match(explorer, /const openTab = \(next: Tab\) => \{ window\.agentrix\.fileTreeFocus\(project\.id, false\); setTab\(next\);/, 'switching to any tab, Agent included, takes the file-tree focus away');
  assert.match(explorer, /enabled=\{!collapsed && filesOpen\}/, 'a hidden tree does not load');
  assert.match(explorer, /useState<Tab>\('agent'\)/, 'a project opens on Agent');
  const app = code('src/App.tsx');
  assert.match(app, /<AgentSidebar project=\{focus\}>\{agent => <ProjectExplorer key=\{focus\.id\} project=\{focus\} agentPanel=\{agent\.panel\} agentRunning=\{agent\.running\}/, 'the app hands the agents module’s node to the explorer');
  const sidebar = code('src/features/agents/AgentSidebar.tsx');
  assert.doesNotMatch(sidebar, /window\.agentrix|toggleSplit|openSplit|writeTerminal/, 'the bridge between the two modules only passes the list on');
});
