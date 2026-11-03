const { exact, id, text, assert, validImages } = require('./validate.cjs');
function registerIpc({ handle, router, settings, claude }) {
  const binding = (terminalId, runtimeSessionId) => assert(id(terminalId) && id(runtimeSessionId));
  handle('native:start', (terminalId, options) => { assert(id(terminalId) && exact(options, ['agent', 'resume']) && ['claude', 'codex'].includes(options.agent) && (options.resume === undefined || typeof options.resume === 'boolean')); return router.start(terminalId, options); });
  handle('native:resume', (terminalId, options) => { assert(id(terminalId) && exact(options, ['agent']) && ['claude', 'codex'].includes(options.agent)); return router.start(terminalId, { ...options, resume: true }); });
  handle('native:send', (terminalId, runtimeSessionId, clientMessageId, value, images) => { binding(terminalId, runtimeSessionId); assert(id(clientMessageId) && text(value) && validImages(images)); return router.send(terminalId, runtimeSessionId, { clientMessageId, text: value, images }); });
  handle('native:interrupt', (terminalId, runtimeSessionId) => { binding(terminalId, runtimeSessionId); return router.interrupt(terminalId, runtimeSessionId); });
  handle('native:stop', (terminalId, runtimeSessionId) => { binding(terminalId, runtimeSessionId); return router.stop(terminalId, runtimeSessionId); });
  handle('native:answer', (terminalId, runtimeSessionId, requestId, answer) => {
    binding(terminalId, runtimeSessionId);
    assert(id(requestId) && (exact(answer, ['decision']) && ['allow', 'deny'].includes(answer.decision) || exact(answer, ['answers']) && exact(answer.answers, Object.keys(answer.answers || {})) && JSON.stringify(answer).length <= 65536 && Object.values(answer.answers).every(value => typeof value === 'string' || Array.isArray(value) && value.every(part => typeof part === 'string'))));
    return router.answer(terminalId, runtimeSessionId, requestId, answer);
  });
  handle('native:snapshot', terminalId => { assert(id(terminalId)); return router.snapshot(terminalId); });
  handle('native:settings-get', () => settings.get());
  handle('native:settings-set', patch => settings.set(patch));
  handle('native:key-save', key => { const result = claude.credentials.save(key); claude.resetAvailability(); return result; });
  handle('native:key-clear', () => router.keyClear());
  handle('native:key-status', () => claude.credentials.status());
  handle('native:usage', () => router.usage());
}
module.exports = { registerIpc };
