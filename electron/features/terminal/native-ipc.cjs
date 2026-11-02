// Stale renderers have no authority to answer the CLI. These retired channels never fall back to keys.
function registerNativeIpc({ handle }) {
  for (const channel of ['terminal:native-approval', 'terminal:native-question', 'terminal:managed-prompt']) {
    handle(channel, () => { throw new Error('Answer in the terminal'); });
  }
}
module.exports = { registerNativeIpc };
