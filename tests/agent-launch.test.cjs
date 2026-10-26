const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { folderHistory, latestCodexSession, launchCommand } = require('../electron/features/agents/launch.cjs');

test('a new project starts each agent fresh, or resumes the conversation found for its folder', () => {
  assert.equal(launchCommand('claude', null), 'claude\r');
  assert.equal(launchCommand('codex', null), 'codex\r');
  assert.equal(launchCommand('claude', { id: '0b7c2b4e-5f0a-4d43-9a43-8f1f2f8f0c11', at: 1 }), 'claude --resume 0b7c2b4e-5f0a-4d43-9a43-8f1f2f8f0c11\r');
  assert.equal(launchCommand('codex', { id: '01a12122-af65-73b0-88ef-19fd79292360', at: 1 }), 'codex resume 01a12122-af65-73b0-88ef-19fd79292360\r');
});

test("the latest Codex conversation is this folder's own, never another project's newer one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-codex-')), day = path.join(home, 'sessions', '2026', '10', '10');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-project-')), other = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-other-'));
  fs.mkdirSync(day, { recursive: true });
  const write = (name, id, cwd, modified) => {
    const file = path.join(day, `rollout-2026-10-10T00-00-00-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'cli' } }) + '\n');
    fs.utimesSync(file, modified, modified);
  };
  write('mine', '01a12122-af65-73b0-88ef-19fd79292360', project, new Date('2026-10-09T10:00:00Z'));
  write('older', '01a12122-af65-73b0-88ef-19fd79292361', project, new Date('2026-10-08T10:00:00Z'));
  write('other', '01a12122-af65-73b0-88ef-19fd79292362', other, new Date('2026-10-10T10:00:00Z'));
  const found = await latestCodexSession(project, home);
  assert.equal(found.id, '01a12122-af65-73b0-88ef-19fd79292360');
  assert.equal(await latestCodexSession(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-empty-')), home), null);
});

test('folder history reports each agent separately and survives one of them failing', async () => {
  const history = await folderHistory('C:\\work', {
    claude: async () => [{ id: 'c1', updatedAt: 5 }, { id: 'c0', updatedAt: 1 }],
    codex: async () => { throw new Error('unreadable'); },
  });
  assert.deepEqual(history, { claude: { id: 'c1', at: 5 }, codex: null });
});

test('public state reserves the reading surface during agent startup and releases it on success, error or exit', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const session = { sessionId: 'session', status: 'starting', agentStarting: true, promptQueue: { list: () => [] } };
  const context = vm.createContext({
    store: { projects: [{ id: 'project', name: 'Project' }], settings: {} }, sessions: new Map([['project', session]]), startupErrors: new Map(),
    terminalIds: () => ['project'], shownTerminalIds: () => ['project'], getBranch: () => '', t: text => text,
    localShell: () => ({ kind: 'powershell' }), process: { platform: 'win32', env: { AGENTRIX_DATA_DIR: 'isolated' } },
    app: { getVersion: () => 'test' }, desktopGlassBackend: null, desktopGlassWindow: false, desktopGlassActive: false,
  });
  vm.runInContext(source.slice(source.indexOf('function publicState('), source.indexOf('function terminalIds(')), context);
  const terminal = () => context.publicState().projects[0].terminals[0];
  assert.equal(terminal().agentStarting, true);
  session.status = 'shell'; assert.equal(terminal().agentStarting, true, 'the first shell prompt still belongs to the pending agent launch');
  session.codexActive = true; assert.equal(terminal().agentStarting, false);
  session.codexActive = false; session.error = 'agent not installed'; assert.equal(terminal().agentStarting, false, 'errors expose the terminal for diagnosis');
  session.error = null; session.status = 'exited'; assert.equal(terminal().agentStarting, false);
  session.status = 'shell'; session.agentStarting = false; assert.equal(terminal().agentStarting, false, 'a plain shell stays visible');
});
