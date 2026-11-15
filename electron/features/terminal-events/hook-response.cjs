// The one builder of what Claude Code's HTTP hooks are answered (G2). Until the owner answers from cards (T5), every
// answer is the empty object: a status hook that answered with context, a system message, `continue` or a decision would
// change what the model sees or does (a Stop given context makes Claude go on by itself), and only the owner decides.
function hookResponse() {
  return '{}';
}

module.exports = { hookResponse };
