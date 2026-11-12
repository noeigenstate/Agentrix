// Which credential Claude Code bills a new session to, read from its initialize answer before any input, and why
// when it is not the saved key or could not be read. A reason (`why`) is a template and its values: the view looks
// the template up for its language, and the Chinese sentence filled here goes to sessions as their failure.
const { createPolicy } = require('./policy.cjs');
const { billingSource, startupFailure, whyText } = require('./identity.cjs');
const { inputQueue, queryOptions, openQuery, readBillingIdentity } = require('./query.cjs');
const { stderrCollector } = require('../agents/start-failure.cjs');

const unknown = why => ({ status: 'unknown', source: null, why, reason: whyText(why) });

// The probe sends no input, so it spends nothing and takes no budget cap: a month with nothing left still has its billing source read.
async function probeBillingIdentity({ key, spec, loadSdk, resolveExecutable, timeoutMs }) {
  const prompt = inputQueue(), abort = new AbortController(), stderr = stderrCollector();
  let query;
  try {
    const executable = await resolveExecutable({ env: spec.env || process.env });
    if (!executable) return unknown({ text: '没有找到能用的 Claude Code，无法确认计费来源。', values: {} });
    const sdk = await loadSdk();
    query = openQuery(sdk, prompt, { ...queryOptions(spec, { key, executable, abort,
      policy: createPolicy(spec), canUseTool: async () => ({ behavior: 'deny', message: 'Connection tests do not execute tools.' }) }), stderr: stderr.push });
    // The queue is never populated: initialize is a control request, not an inference turn.
    return { status: 'ok', source: await readBillingIdentity(query, { signal: abort.signal, timeoutMs }) };
  } catch (error) {
    // The executable check's own sentence (too old, or found but not verified).
    if (error?.code === 'native_cli_required') return unknown({ text: error.message, values: {} });
    const failure = startupFailure(error, { stderr: stderr.text(), key });
    if (failure.code === 'credits_exhausted') return { ...unknown(failure.why), credits: true };
    if (failure.code === 'billing_identity_mismatch') {
      return { status: 'mismatch', source: billingSource(failure.source), reported: failure.reported, why: failure.why, reason: failure.message };
    }
    return unknown(failure.why ?? { text: failure.message, values: {} });
  } finally {
    prompt.close(); abort.abort();
    try { query?.close(); } catch { }
  }
}
module.exports = { probeBillingIdentity };
