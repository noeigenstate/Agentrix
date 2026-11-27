const { createRpc: createStdioRpc, MAX_FRAME } = require('../../shared/stdio-rpc.cjs');
const HISTORY_READS = new Set(['thread/turns/list', 'thread/items/list']);

function createRpc(child, options) {
  return createStdioRpc(child, {
    ...options,
    jsonrpc: false,
    oversizedResponseCode: method => HISTORY_READS.has(method) ? 'history_frame_limit' : null,
    passthroughErrorCodes: ['codex_cli_required'],
    errorDetails: ({ code, message }) => ({
      // 0.166 reports parameter deserialization failures as Invalid Request. Keep only the static classification.
      missingThreadId: code === -32600 && message === 'Invalid request: missing field `threadId`',
      missingThread: code === -32600 && /^no rollout found for thread id [a-f\d-]{36}$/i.test(message),
    }),
  });
}

module.exports = { createRpc, MAX_FRAME };
