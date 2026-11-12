const { exact, id, text, assert, validImages, validSwitchAnswer, validHandoff } = require('./validate.cjs');
const { CODEX_PERMISSIONS } = require('../../codex-permissions.cjs');
function registerIpc({ handle, router, settings, claude }) {
  const binding = (terminalId, runtimeSessionId) => assert(id(terminalId) && id(runtimeSessionId));
  handle('native:start', (terminalId, options) => { assert(id(terminalId) && exact(options, ['agent', 'resume']) && ['claude', 'codex'].includes(options.agent) && (options.resume === undefined || typeof options.resume === 'boolean')); return router.start(terminalId, options); });
  handle('native:resume', (terminalId, options) => { assert(id(terminalId) && exact(options, ['agent']) && ['claude', 'codex'].includes(options.agent)); return router.start(terminalId, { ...options, resume: true }); });
  handle('native:send', (terminalId, runtimeSessionId, clientMessageId, value, images) => { binding(terminalId, runtimeSessionId); assert(id(clientMessageId) && text(value, 262144, !!images?.length) && validImages(images)); return router.send(terminalId, runtimeSessionId, { clientMessageId, text: value, images }); });
  handle('native:interrupt', (terminalId, runtimeSessionId) => { binding(terminalId, runtimeSessionId); return router.interrupt(terminalId, runtimeSessionId); });
  handle('native:stop', (terminalId, runtimeSessionId) => { binding(terminalId, runtimeSessionId); return router.stop(terminalId, runtimeSessionId); });
  handle('native:answer', (terminalId, runtimeSessionId, requestId, answer) => {
    binding(terminalId, runtimeSessionId);
    assert(id(requestId) && (validSwitchAnswer(answer) || validHandoff(answer) || exact(answer, ['decision']) && ['allow', 'deny'].includes(answer.decision) || exact(answer, ['answers']) && exact(answer.answers, Object.keys(answer.answers || {})) && JSON.stringify(answer).length <= 65536 && Object.values(answer.answers).every(value => typeof value === 'string' || Array.isArray(value) && value.every(part => typeof part === 'string'))));
    if (answer.switch) assert(requestId === answer.switch.requestId);
    if (answer.handoff) assert(requestId === `handoff-${answer.handoff.changeId}`);
    return router.answer(terminalId, runtimeSessionId, requestId, answer);
  });
  handle('native:snapshot', terminalId => { assert(id(terminalId)); return router.snapshot(terminalId); });
  handle('native:commands', (...args) => { assert(args.length === 2); binding(...args); return router.commands(...args); });
  handle('native:run-options', (terminalId, runtimeSessionId, patch) => {
    binding(terminalId, runtimeSessionId);
    assert(exact(patch, ['model', 'effort', 'fast', 'permissions']) && (patch.model === undefined || patch.model === null || text(patch.model, 160))
      && (patch.effort === undefined || patch.effort === null || typeof patch.effort === 'string' && /^[\w-]{1,32}$/.test(patch.effort))
      && (patch.fast === undefined || typeof patch.fast === 'boolean') && (patch.permissions === undefined || CODEX_PERMISSIONS.includes(patch.permissions)));
    return router.runOptions(terminalId, runtimeSessionId, patch);
  });
  handle('native:models', (terminalId, runtimeSessionId) => { binding(terminalId, runtimeSessionId); return router.models(terminalId, runtimeSessionId); });
  handle('native:new-conversation', (terminalId, runtimeSessionId) => { binding(terminalId, runtimeSessionId); return router.newConversation(terminalId, runtimeSessionId); });
  handle('native:shell', (terminalId, runtimeSessionId, clientMessageId, command) => {
    binding(terminalId, runtimeSessionId); assert(id(clientMessageId) && text(command, 262144) && command === command.trim());
    return router.shell(terminalId, runtimeSessionId, clientMessageId, command);
  });
  handle('native:settings-get', () => settings.get());
  handle('native:settings-set', patch => settings.set(patch));
  handle('native:key-save', key => router.keySave(key));
  handle('native:key-clear', () => router.keyClear());
  handle('native:key-status', () => claude.credentials.status());
  handle('native:usage', projectId => { assert(projectId === undefined || id(projectId)); return router.usage(projectId); });
  handle('native:test-connection', (...args) => { assert(args.length <= 1 && (args[0] === undefined || id(args[0]))); return router.testConnection(args[0]); });
}
module.exports = { registerIpc };
