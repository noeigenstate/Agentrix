const { apiEnvironment } = require('./credentials.cjs');
const { billingIdentityError } = require('./identity.cjs');
const { routeSettings } = require('./routing.cjs');
const { LOOKUP_AGENT_NAME, LOOKUP_AGENT, lookupDecision } = require('./lookup-agent.cjs');
const { seatHookOutput, observedAgentSeat } = require('../skills/agent-seat.cjs');
const { EFFORT, familyOf, validModel } = require('../skills/seat-rules.mjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// These instructions describe host capabilities proved by the paired real-CLI tests.
// Keep the CLI's own preset and entrypoint; do not replace its system prompt.
const IDENTITY_CONTEXT = "You are Claude Code, Anthropic's official CLI for Claude.";
const NATIVE_SHELL_CONTEXT = IDENTITY_CONTEXT + '\n'
  + 'If you need the user to run a shell command themselves, suggest they type `! <command>` in the prompt; its output becomes context in this conversation.\n';
const LOOKUP_GUIDANCE = 'Batch related lookups into one call and read its concise conclusions. Run CI judgments, diffs you must review and release steps yourself.';
const NATIVE_CONTEXT = NATIVE_SHELL_CONTEXT
  + `Delegate simple grep, file listings and short log lookups to the ${LOOKUP_AGENT_NAME} Haiku 5.5 subagent. ${LOOKUP_GUIDANCE}`;

function nativeContext(lookup = LOOKUP_AGENT) {
  if (lookup === null) return NATIVE_SHELL_CONTEXT + `Follow the routing skill's lookup row for simple grep, file listings and short log lookups. ${LOOKUP_GUIDANCE}`;
  return lookup.model === LOOKUP_AGENT.model ? NATIVE_CONTEXT : NATIVE_CONTEXT.replace('Haiku 5.5', lookup.model);
}

function lookupOptions(override) {
  if (override === null) return null;
  const { model, effort } = override || {};
  return {
    ...LOOKUP_AGENT,
    ...(validModel(model) && familyOf(model) === 'claude' && { model }),
    ...(typeof effort === 'string' && EFFORT.test(effort) && { effort }),
  };
}

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

function queryOptions(spec, { key, executable, abort, providerSessionId, policy, canUseTool, onSubagent = () => {}, onSeat = () => {} }) {
  const lookupAgent = spec.owner === 'gui' ? lookupOptions(spec.operations?.lookupAgent) : null;
  const reportSubagent = kind => async (input, toolUseId) => {
    // Visibility must never block the CLI or add context to either conversation.
    try { void Promise.resolve(onSubagent(kind, input, toolUseId)).catch(() => {}); } catch { }
    return {};
  };
  return {
    cwd: spec.cwd, model: spec.model || undefined, effort: spec.effort || 'high', pathToClaudeCodeExecutable: executable,
    settings: privateSettings({ fastMode: spec.fast === true, ...routeSettings(spec) }, abort.signal),
    env: apiEnvironment(spec.env || process.env, key, spec.owner || 'gui', spec.operations?.env),
    // The owner's choice: SDK sessions do not ask about each tool. A worker's limits are its PreToolUse policy, which still denies under
    // this mode, and questions still reach canUseTool: both proved against the real CLI in tests/claude-sdk-real-cli.test.cjs.
    abortController: abort, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, includePartialMessages: true,
    settingSources: ['user', 'project', 'local'],
    ...(lookupAgent ? { agents: { [LOOKUP_AGENT_NAME]: lookupAgent } } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: [spec.owner === 'gui' ? nativeContext(lookupAgent) : IDENTITY_CONTEXT,
      spec.owner === 'gui' && !Object.entries(spec.env || process.env).some(([name, value]) => name.toUpperCase() === 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS' && value === '1')
        ? 'The fork subagent runs in the background, so you can keep chatting with the user while it works.' : null,
      spec.context].filter(Boolean).join('\n\n') },
    ...(providerSessionId ? { resume: providerSessionId } : {}),
    hooks: { PreToolUse: [{ onFailure: 'block', hooks: [async input => {
      const lookup = lookupAgent && lookupDecision(input);
      if (lookup) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: lookup,
        permissionDecisionReason: 'Lookup Bash supports only pwd and fixed ls forms; use Read, Grep or Glob for other lookups.' } };
      const decision = policy(input.tool_name, input.tool_input);
      // The policy's 'defer' means "not ours to decide". To the CLI a hook's 'defer' means "pause this tool and end the turn",
      // so the owner's rules get their say by the hook answering nothing.
      if (decision.behavior === 'defer') {
        const output = seatHookOutput(input, spec.seatsMap);
        if (output.systemMessage) try { onSeat(input, { note: output.systemMessage }); } catch {}
        return output;
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.behavior, permissionDecisionReason: decision.reason } };
    }] }],
    ...(spec.seatsMap && { PostToolUse: [{ matcher: 'Agent|Task', hooks: [async input => {
      const observed = observedAgentSeat(input, spec.seatsMap);
      if (observed) try { onSeat(input, observed); } catch {}
      return {};
    }] }] }),
    SubagentStart: [{ hooks: [reportSubagent('start')] }],
    SubagentStop: [{ hooks: [reportSubagent('stop')] }] },
    canUseTool,
  };
}

function openQuery(sdk, prompt, options) {
  return sdk.query({ prompt, options });
}

// The deadline yields one turn of the event loop before it fails: an initialize answer already waiting while main was
// busy wins, so a busy main is not taken for a slow CLI. The failure says how long it waited.
async function readBillingIdentity(query, { signal, timeoutMs = 30000 }) {
  const started = Date.now();
  let timer, abort, initialization;
  try {
    initialization = await Promise.race([query.initializationResult(), new Promise((_, reject) => {
      abort = () => reject(new Error('会话已停止。'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      timer = setTimeout(() => setImmediate(() => reject(Object.assign(new Error('sdk_initialization_timeout'),
        { code: 'sdk_initialization_timeout', elapsedMs: Date.now() - started }))), timeoutMs);
    })]);
  } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  if (signal.aborted) throw new Error('会话已停止。');
  const source = initialization?.account?.apiKeySource, tokenSource = initialization?.account?.tokenSource;
  if (source !== 'ANTHROPIC_API_KEY' || ['apiKeyHelper', 'ANTHROPIC_AUTH_TOKEN'].includes(tokenSource)) {
    throw billingIdentityError(source, { beforeInput: true, tokenSource });
  }
  return source;
}

module.exports = { inputQueue, queryOptions, openQuery, readBillingIdentity, nativeContext, NATIVE_CONTEXT, IDENTITY_CONTEXT };
