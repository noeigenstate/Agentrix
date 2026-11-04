const { apiEnvironment } = require('./credentials.cjs');
const { billingIdentityError } = require('./identity.cjs');

function inputQueue(onTake = () => {}) {
  const values = [];
  let wake, closed = false;
  return {
    push(value) {
      if (closed) throw new Error('会话已停止。');
      values.push(value); wake?.();
    },
    close() { closed = true; values.length = 0; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (!values.length) await new Promise(resolve => { wake = resolve; });
        wake = null;
        if (!closed && values.length) {
          const value = values.shift(); onTake(value.uuid); yield value;
        }
      }
    },
  };
}

function queryOptions(spec, { key, executable, configDirectory, abort, providerSessionId, maxBudgetUsd, policy, canUseTool }) {
  return {
    cwd: spec.cwd, model: spec.model || undefined, effort: spec.effort || 'high', pathToClaudeCodeExecutable: executable,
    settings: { fastMode: spec.fast === true }, env: { ...apiEnvironment(spec.env || process.env, key, spec.owner || 'gui'),
      ...(configDirectory ? { CLAUDE_CONFIG_DIR: configDirectory } : {}) },
    abortController: abort, permissionMode: 'default', includePartialMessages: true,
    settingSources: spec.owner === 'dispatch' ? [] : ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.context || '' },
    ...(providerSessionId ? { resume: providerSessionId } : {}),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    hooks: { PreToolUse: [{ onFailure: 'block', hooks: [async input => {
      const decision = policy(input.tool_name, input.tool_input);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.behavior, permissionDecisionReason: decision.reason } };
    }] }] },
    canUseTool,
  };
}

async function readBillingIdentity(query, { signal, timeoutMs = 30000 }) {
  let timer, abort, initialization;
  try {
    initialization = await Promise.race([query.initializationResult(), new Promise((_, reject) => {
      abort = () => reject(new Error('会话已停止。'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      timer = setTimeout(() => reject(Object.assign(new Error('sdk_initialization_timeout'), { code: 'sdk_initialization_timeout' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  if (signal.aborted) throw new Error('会话已停止。');
  const source = initialization?.account?.apiKeySource;
  if (source !== 'ANTHROPIC_API_KEY') throw billingIdentityError(source, { beforeInput: true });
  return source;
}

module.exports = { inputQueue, queryOptions, readBillingIdentity };
