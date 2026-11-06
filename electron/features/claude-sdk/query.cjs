const { apiEnvironment } = require('./credentials.cjs');
const { billingIdentityError } = require('./identity.cjs');
const { routeSettings } = require('./routing.cjs');
const { LOOKUP_AGENT_NAME, LOOKUP_AGENT, lookupDecision } = require('./lookup-agent.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// These instructions describe host capabilities proved by the paired real-CLI tests.
// Keep the CLI's own preset and entrypoint; do not replace its system prompt.
const IDENTITY_CONTEXT = "You are Claude Code, Anthropic's official CLI for Claude.";
const NATIVE_CONTEXT = IDENTITY_CONTEXT + '\n'
  + 'If you need the user to run a shell command themselves, suggest they type `! <command>` in the prompt; its output becomes context in this conversation.\n'
  + 'The fork subagent runs in the background, so you can keep chatting with the user while it works.\n'
  + `Delegate simple grep, file listings and short log lookups to the ${LOOKUP_AGENT_NAME} Haiku 5.5 subagent. Batch related lookups into one call and read its concise conclusions. Run CI judgments, diffs you must review and release steps yourself.`;

function privateSettings(value, signal) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-claude-settings-'));
  const file = path.join(directory, 'settings.json');
  const remove = () => { try { fs.unlinkSync(file); } catch { } try { fs.rmdirSync(directory); } catch { } };
  try {
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    signal.addEventListener('abort', remove, { once: true });
    if (signal.aborted) remove();
    return file;
  } catch (error) { remove(); throw error; }
}

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

function queryOptions(spec, { key, executable, abort, providerSessionId, maxBudgetUsd, policy, canUseTool }) {
  return {
    cwd: spec.cwd, model: spec.model || undefined, effort: spec.effort || 'high', pathToClaudeCodeExecutable: executable,
    settings: privateSettings({ fastMode: false, ...routeSettings(spec) }, abort.signal), env: apiEnvironment(spec.env || process.env, key, spec.owner || 'gui'),
    // The owner's choice: SDK sessions do not ask about each tool. A worker's limits are its PreToolUse policy, which still denies under
    // this mode, and questions still reach canUseTool: both proved against the real CLI in tests/claude-sdk-real-cli.test.cjs.
    abortController: abort, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, includePartialMessages: true,
    settingSources: ['user', 'project', 'local'],
    ...(spec.owner === 'gui' ? { agents: { [LOOKUP_AGENT_NAME]: LOOKUP_AGENT } } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: [spec.owner === 'gui' ? NATIVE_CONTEXT : IDENTITY_CONTEXT, spec.context].filter(Boolean).join('\n\n') },
    ...(providerSessionId ? { resume: providerSessionId } : {}),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    hooks: { PreToolUse: [{ onFailure: 'block', hooks: [async input => {
      const lookup = spec.owner === 'gui' && lookupDecision(input);
      if (lookup) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: lookup,
        permissionDecisionReason: 'Lookup Bash supports only pwd and fixed ls forms; use Read, Grep or Glob for other lookups.' } };
      const decision = policy(input.tool_name, input.tool_input);
      // The policy's 'defer' means "not ours to decide". To the CLI a hook's 'defer' means "pause this tool and end the turn",
      // so the owner's rules get their say by the hook answering nothing.
      if (decision.behavior === 'defer') return {};
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
  const source = initialization?.account?.apiKeySource, tokenSource = initialization?.account?.tokenSource;
  if (source !== 'ANTHROPIC_API_KEY' || ['apiKeyHelper', 'ANTHROPIC_AUTH_TOKEN'].includes(tokenSource)) {
    throw billingIdentityError(source, { beforeInput: true, tokenSource });
  }
  return source;
}

module.exports = { inputQueue, queryOptions, readBillingIdentity, NATIVE_CONTEXT, IDENTITY_CONTEXT };
