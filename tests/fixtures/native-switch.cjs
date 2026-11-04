const assert = require('node:assert/strict');
function terminalPreparation(committed) {
  return async spec => ({ session: { identity: {}, spec, path: 'terminal' }, cancel() {}, commit() { committed(spec); } });
}
async function completeSwitch(router, id) {
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setImmediate(resolve));
    const state = router.switchState(id);
    if (state?.phase === 'stable' && state.current === 'terminal') return;
    const runtimeSessionId = router.snapshot(id)?.runtimeSessionId || id;
    if (state?.phase === 'awaiting-choice') router.answer(id, runtimeSessionId, state.requestId, { switch: { changeId: state.changeId, requestId: state.requestId, action: 'now' } });
    if (state?.phase === 'preparing') router.answer(id, runtimeSessionId, `handoff-${state.changeId}`, { handoff: { changeId: state.changeId,
      draft: { version: 1, text: '', images: [], undelivered: [] } } });
  }
  assert.fail('the coordinated fallback did not settle');
}
module.exports = { terminalPreparation, completeSwitch };
