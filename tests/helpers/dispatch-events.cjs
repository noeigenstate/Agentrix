const { dispatchEvent } = require('../../integration/dispatch.cjs');

function started(id, agent = 'codex', fields = {}) {
  return dispatchEvent('started', id, { agent, model: 'fixture', effort: null, fast: null, pid: 7, session: 'synthetic',
    routing: { verdict: 'ok', unverified: [], fallback: false }, ...fields });
}

function ended(id, reason = 'exit', fields = {}) {
  return dispatchEvent('ended', id, { agent: 'codex', model: 'fixture', effort: null, fast: null, exitCode: 0, reason,
    rate: null, scope: { state: 'off', count: 0, files: [] }, refused: { count: 0 }, needsDecision: false,
    result: { source: 'final-text', out: 'answer.md' }, routing: null, ...fields });
}

function waiting(id, message = 'waiting for sandbox permissions') {
  return dispatchEvent('waiting', id, { kind: 'sandbox', message });
}

function running(id, message) {
  return dispatchEvent('running', id, { seconds: 4, lastActivityAt: Date.now(), ...(message && { waiting: waiting(id, message) }) });
}

const failure = message => dispatchEvent('failed', null, { message });
const stopped = id => dispatchEvent('notice', id, { code: 'stop_queued' });
module.exports = { started, ended, waiting, running, failure, stopped };
