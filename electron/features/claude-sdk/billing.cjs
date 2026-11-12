// Which credential Claude Code bills a new session to, read from its initialize answer before any input, and why
// when it is not the saved key or could not be read. A reason (`why`) is a template and its values: the view looks
// the template up for its language, and the Chinese sentence filled here goes to sessions as their failure.
const { createPolicy } = require('./policy.cjs');
const { billingSource, startupFailure, whyText } = require('./identity.cjs');
const { inputQueue, queryOptions, readBillingIdentity } = require('./query.cjs');
const { stderrTail } = require('../agents/start-failure.cjs');
const STDERR_KEPT = 8192;

// A start that failed before the initialize answer, from the SDK error's own fields (errorClass, exitCode, signal) and
// the redacted end of the stderr this probe collected, the key removed.
function failureWhy(error, stderr, key) {
  const values = { stderr: stderrTail(stderr.split(key).join('<key>')) };
  const output = values.stderr ? '，错误输出：{stderr}' : '，没有错误输出。';
  if (error?.errorClass === 'process_exited_nonzero' && Number.isInteger(error.exitCode)) {
    return { text: `Claude Code 启动后退出（退出码 {code}）${output}`, values: { ...values, code: error.exitCode } };
  }
  if (error?.errorClass === 'process_killed_by_signal' && typeof error.signal === 'string') {
    return { text: `Claude Code 启动后被终止（信号 {signal}）${output}`, values: { ...values, signal: error.signal } };
  }
  // A process that never ran names its system error code (spawn EPERM, ENOENT…) when it has one.
  const code = typeof error?.code === 'string' && /^E[A-Z0-9]{2,20}$/.test(error.code) ? error.code : null;
  return code ? { text: `Claude Code 没能启动（{code}）${output}`, values: { ...values, code } } : { text: `Claude Code 没能启动${output}`, values };
}
function unknown(why) { return { status: 'unknown', source: null, why, reason: whyText(why) }; }
function timedOut(error) {
  return unknown({ text: 'Claude Code 初始化 {seconds} 秒仍未完成，无法确认计费来源。请稍后重试。', values: { seconds: Math.max(1, Math.round(error.elapsedMs / 1000)) } });
}

async function probeBillingIdentity({ key, spec, loadSdk, resolveExecutable, maxBudgetUsd, timeoutMs }) {
  const prompt = inputQueue(), abort = new AbortController();
  let query, stderr = '';
  try {
    const executable = await resolveExecutable({ env: spec.env || process.env });
    if (!executable) return unknown({ text: '没有找到能用的 Claude Code，无法确认计费来源。', values: {} });
    const sdk = await loadSdk();
    query = sdk.query({ prompt, options: { ...queryOptions(spec, { key, executable, abort, maxBudgetUsd,
      policy: createPolicy(spec), canUseTool: async () => ({ behavior: 'deny', message: 'Connection tests do not execute tools.' }) }),
    stderr: chunk => { stderr = (stderr + chunk).slice(-STDERR_KEPT); } } });
    // The queue is never populated: initialize is a control request, not an inference turn.
    return { status: 'ok', source: await readBillingIdentity(query, { signal: abort.signal, timeoutMs }) };
  } catch (error) {
    const failure = startupFailure(error);
    if (failure.code === 'billing_identity_mismatch') {
      return { status: 'mismatch', source: billingSource(failure.source), reported: failure.reported, why: failure.why, reason: failure.message };
    }
    if (failure.code === 'sdk_initialization_timeout') return timedOut(error);
    // The executable check's own sentence (too old, or found but not verified).
    if (error?.code === 'native_cli_required') return unknown({ text: error.message, values: {} });
    if (failure.code === 'sdk_startup_failed') return unknown(failureWhy(error, stderr, key));
    return unknown({ text: failure.message, values: {} });
  } finally {
    prompt.close(); abort.abort();
    try { query?.close(); } catch { }
  }
}
module.exports = { probeBillingIdentity };
