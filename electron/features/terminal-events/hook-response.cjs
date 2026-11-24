// The one builder of what Claude Code's HTTP hooks are answered (G2). Until the owner answers from cards (T5), every
// answer is the empty object: a status hook that answered with context, a system message, `continue` or a decision would
// change what the model sees or does (a Stop given context makes Claude go on by itself), and only the owner decides.
// The one exception is the owner's own switch of the session's mode: main's note about it rides the owner's next prompt
// as context. It comes from main alone, never from the request, and no other event carries it.
const { adapterOf } = require('../cli-adapters/registry.cjs');

function hookResponse(event, note) {
  if (event !== 'UserPromptSubmit' || typeof note !== 'string' || !note) return '{}';
  return JSON.stringify(adapterOf('claude').notes.message(note).hook);
}

module.exports = { hookResponse };
