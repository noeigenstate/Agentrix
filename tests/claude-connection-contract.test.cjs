// R2 contract: the connection test and a new session in the same project take their path from the same facts, so they
// agree. Fakes only: no real API, CLI or ~/.claude.
require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { routeFixture } = require('./fixtures/claude-route.cjs');

const MODES = ['api-then-terminal', 'api-only', 'terminal-only'];
const CLIS = [{ status: 'ok', version: '2.1.318' }, { status: 'missing', reason: 'not_found' }, { status: 'too_old', version: '2.1.300' },
  { status: 'missing', reason: 'timeout', found: 'claude.exe' }];
const BILLING = ['ANTHROPIC_API_KEY', '/login managed key'];

test('the connection test and a new session choose the same path and billing for every fact set', async t => {
  for (const mode of MODES) for (const key of ['ok', 'missing', 'invalid', 'credits']) for (const cli of CLIS) for (const billing of BILLING) {
    const label = JSON.stringify({ mode, key, cli: cli.reason || cli.status, billing });
    const f = routeFixture(t, { mode, key, cli, billing });
    const tested = await f.native.testConnection('p'), queries = f.fake.calls.length;
    const session = await f.newSession('n');
    assert.equal(session.path, tested.path, `${label}: the same path`);
    if (tested.path === 'api') {
      // The test confirmed this key bills the session: its first message is accepted on the API.
      assert.equal(tested.billing.status, 'ok', label);
      const receipt = await f.native.send('n', session.runtimeSessionId, { clientMessageId: 'm', text: 'synthetic only' });
      assert.notEqual(receipt.status, 'rejected', label);
    } else {
      // A session the test keeps off the API asks Claude Code nothing, and both say why in the words the windows know.
      assert.equal(f.fake.calls.length, queries, `${label}: no SDK query`);
      const cause = causeOf({ key, cli, billing });
      assert.equal(tested.reason, cause.wire, `${label}: the test says why`);
      if (session.path === null) assert.equal(session.reason, cause.refused, `${label}: the refused start says why`);
      else assert.equal(session.reason, mode === 'terminal-only' ? 'terminal_selected' : cause.session, `${label}: the session says why`);
    }
  }
});

// What the test and a new session say for the first fact that keeps the API out: `wire` the test's reason, `session`
// the new session's path reason and `refused` the sentence an API-only start is refused with.
const GENERAL = 'Claude API 路径当前不可用。', CREDITS = '控制台余额不足，请到 Claude Console 的 Billing 充值。';
const CLI_SAID = {
  not_found: { wire: 'native_cli_required', refused: '未找到原生 Claude Code，无法通过 API 运行' },
  too_old: { wire: 'Claude Code 版本过低，请升级到 2.1.317 或更高', refused: 'Claude Code 版本过低，请升级到 2.1.317 或更高' },
  timeout: { wire: 'native_cli_unverified', refused: 'Claude Code 检查没有通过，无法通过 API 运行' },
};
function causeOf({ key, cli, billing }) {
  if (key === 'missing' || key === 'invalid') { const name = key === 'missing' ? 'no_key' : 'invalid_key'; return { wire: name, session: name, refused: GENERAL }; }
  if (cli.status !== 'ok') { const said = CLI_SAID[cli.reason || cli.status]; return { ...said, session: said.wire }; }
  if (billing !== 'ANTHROPIC_API_KEY') {
    const sentence = 'Claude Code 用的是 /login 登录 Anthropic 控制台时保存的密钥，不是这个密钥。请在 Claude Code 里退出这个登录后重试。（apiKeySource=/login managed key）';
    return { wire: 'billing_identity_mismatch', session: sentence, refused: sentence };
  }
  if (key === 'credits') return { wire: CREDITS, session: CREDITS, refused: CREDITS };
  return { wire: 'terminal_selected', session: 'terminal_selected' };
}

test('an answer the connection test could not get is told by the test and never held for the next session', async t => {
  const f = routeFixture(t, { key: 'unreachable' });
  const tested = await f.native.testConnection('p');
  assert.equal(tested.path, 'terminal'); assert.equal(tested.reason, '无法连接 Anthropic API。');
  assert.equal((await f.newSession('n')).path, 'api', 'an unreachable API is not a fact about the key');
});
