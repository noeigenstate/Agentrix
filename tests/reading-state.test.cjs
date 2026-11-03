const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readingState, validCliState } = require('../src/features/reading/reading-state.ts');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const { cliInputDraft } = require('../src/features/reading/cli-panel.ts');
const { popupHarness, elements, idle } = require('./reading-popup-coverage.test.cjs');

// Synthetic compatibility cases, not claimed as captures from a live authenticated CLI.
for (const file of fs.readdirSync(path.join(__dirname, 'fixtures/screens')).filter(name => name.includes('-compat-'))) {
  test(file + ': missing footer, clipped input and ordinary output never imply a dialog', () => {
    const agent = file.startsWith('claude') ? 'claude' : 'codex';
    const rows = fs.readFileSync(path.join(__dirname, 'fixtures/screens', file), 'utf8').split(/\r?\n/);
    const screen = parseAgentScreen(agent, rows), state = readingState(agent, rows, screen, { needsInput: null, codexActivity: 'complete' });
    assert.equal(state.waiting, false);
    if (!/clipped|stream|resize/.test(file)) assert.equal(state.idle, true);
    if (/stream/.test(file)) assert.equal(state.working, true);
    if (/draft|notice|short-footer/.test(file)) assert.ok(cliInputDraft(agent, rows, screen));
  });
}

for (const agent of ['claude', 'codex']) {
  test(agent + ': a newer PTY input frame clears host waiting in the same render, and a newer host event wins again', t => {
    const h = popupHarness(t, agent, ['Settings', 'Esc to close']);
    h.props.terminal.cliState = { sessionId: 'fixture-session', revision: 1, state: 'waiting', updatedAt: 10000 };
    h.view.frame = { sessionId: 'fixture-session', revision: 1, updatedAt: 9999 }; h.render(); assert.ok(h.popup());
    h.view.rows = idle[agent]; h.view.frame = { ...h.view.frame, revision: 2, updatedAt: 10001 }; h.render();
    assert.equal(h.popup(), undefined); assert.equal(h.waiting(), undefined); assert.equal(h.node.disabled, false);
    h.props.terminal.cliState = { ...h.props.terminal.cliState, revision: 2, updatedAt: 10002 }; h.render(); assert.ok(h.popup());
  });
  test(agent + ': a transient unknown redraw cannot rearm a dismissed confirmation', t => {
    const h = popupHarness(t, agent, ['Settings', 'Esc to close']);
    h.popup().props.onClose(); h.render();
    h.view.rows = ['Partial redraw']; h.render();
    h.view.rows = ['Settings', 'Esc to close']; h.render();
    assert.equal(h.popup(), undefined); assert.ok(h.waiting());
  });
  test(agent + ': stale attention and working clear on the first idle frame, without subsequent output', t => {
    const h = popupHarness(t, agent, ['Settings', 'Esc to close'], 'working');
    h.props.terminal.needsInput = 'old permission'; h.render(); assert.ok(h.popup());
    h.view.rows = idle[agent]; h.render();
    assert.equal(h.waiting(), undefined); assert.equal(h.popup(), undefined); assert.equal(h.node.disabled, false);
    assert.equal(elements(h.tree()).some(node => node.props.className === 'reading-status is-waiting'), false);
    h.tick(100); assert.equal(h.waiting(), undefined);
    assert.equal(elements(h.tree()).some(node => node.type?.name === 'WorkingLine'), false);
  });

  test(agent + ': versioned host state wins old rows and rejects a late revision or another PTY', t => {
    const h = popupHarness(t, agent, ['Settings', 'Esc to close']);
    const signal = (revision, state) => ({ sessionId: 'fixture-session', revision, state, updatedAt: 10000 + revision });
    h.props.terminal.cliState = signal(2, 'idle'); h.render(); assert.equal(h.waiting(), undefined);
    h.props.terminal.cliState = signal(2, 'waiting'); h.render(); assert.equal(h.waiting(), undefined, 'duplicate revision cannot change state');
    h.props.terminal.cliState = signal(1, 'waiting'); h.render(); assert.equal(h.waiting(), undefined);
    h.props.terminal.cliState = signal(3, 'waiting'); h.render(); assert.ok(h.popup());
    h.view.rows = idle[agent]; h.render(); assert.ok(h.popup(), 'old input cannot clear newer host attention');
    h.props.terminal.cliState = signal(4, 'idle'); h.render(); assert.equal(h.waiting(), undefined);
    assert.equal(validCliState({ sessionId: 'different', cliState: signal(5, 'waiting') }), null);
  });

  test(agent + ': unknown output stays editable and never opens a confirmation popup', t => {
    const h = popupHarness(t, agent, ['Normal result with a new layout']);
    h.tick(10000); assert.equal(h.popup(), undefined); assert.equal(h.waiting(), undefined);
    assert.equal(h.node.disabled, false);
    h.edit('next instruction'); h.keys('Enter');
    assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
    assert.ok(elements(h.tree()).some(node => node.props.className === 'reading-outbox'));
  });
}
