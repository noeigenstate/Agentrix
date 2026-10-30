const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProjectHandoff } = require('../electron/app/project-handoff.cjs');
const { setThumbnailer } = require('../electron/conversation.cjs');

test('SSH project handoff converts only text and never decodes local or inline pictures', async t => {
  const prefix = path.join(os.tmpdir(), 'agentrix-handoff-pictures-'), root = await fs.mkdtemp(prefix);
  t.after(async () => { setThumbnailer(() => null); assert.ok(path.resolve(root).startsWith(prefix)); await fs.rm(root, { recursive: true, force: true }); });
  let decoded = 0; setThumbnailer(() => { decoded++; }, () => { decoded++; });
  const project = { id: 'p', kind: 'ssh', path: '/srv/project', ssh: { host: 'fixture' } }, writes = [];
  const session = { terminalId: 't', terminal: { request: async (op, value) => {
    if (op === 'write-handoff') { writes.push(value.text); return; }
    assert.equal(op, 'history');
    return { codex: [{ id: 'test', records: [
      { timestamp: '2026-10-30T08:00:00Z', type: 'event_msg', payload: { type: 'item_completed', item: { id: 'ask', type: 'UserMessage', content: [{ type: 'text', text: 'Describe this' }, { type: 'local_image', path: path.join(root, 'picture.png') }] } } },
      { timestamp: '2026-10-30T08:00:01Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Synthetic reply' } },
    ] }], claude: [] };
  } } };
  const sessions = new Map([['t', session]]), store = { projects: [project], findTerminal: () => ({ record: {} }) };
  const handoff = createProjectHandoff({ app: { getPath: () => root }, getStore: () => store, sessions });
  await handoff.sshHandoff(project, session);
  assert.equal(decoded, 0); assert.equal(writes.length, 1); assert.match(writes[0], /Describe this/); assert.match(writes[0], /Synthetic reply/);
});
