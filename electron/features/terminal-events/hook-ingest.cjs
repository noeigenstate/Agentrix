const { timingSafeEqual } = require('node:crypto');

// What a hook event keeps of Claude Code's payload: its plain fields, strings cut short; tool input and output, which
// can be large, stay in the transcript.
const FIELDS = 32, TEXT = 2000;
const text = value => typeof value === 'string' ? value : '';
function subset(payload) {
  const plain = Object.entries(payload).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value));
  const kept = Object.fromEntries(plain.slice(0, FIELDS).map(([name, value]) => [name, typeof value === 'string' ? value.slice(0, TEXT) : value]));
  // A continuation needs only its target. Message text and the rest of tool input stay in the transcript.
  if (payload.tool_name === 'SendMessage' && payload.tool_input && typeof payload.tool_input === 'object') {
    kept.tool_input = Object.fromEntries(['to', 'recipient', 'recipient_kind'].filter(name => typeof payload.tool_input[name] === 'string')
      .map(name => [name, payload.tool_input[name].slice(0, TEXT)]));
  }
  return kept;
}
function sameKey(expected, given) {
  const a = Buffer.from(expected), b = Buffer.from(typeof given === 'string' ? given : '');
  return a.length === b.length && timingSafeEqual(a, b);
}

// The hook server's requests become TerminalHookEvents (C-2) for `deliver`, numbered in arrival order. `keyOf(terminalId)`
// is the key a live terminal's hooks carry. Every refused request and every event that lost its payload is counted, for
// pipeline health; nothing is dropped silently. `noteOf(terminalId)` hands over, once, what main tells that session next.
function createHookIngest({ keyOf, deliver, noteOf = () => null, now = Date.now }) {
  let seq = 0, lastEventAt = null;
  const counts = { received: 0, oversize: 0, unparsable: 0, failed: 0, aborted: 0, refused: { path: 0, terminal: 0, key: 0 }, events: Object.create(null) };

  // Whether a request reaches a live terminal with that terminal's key; terminalId is null for a path that names none.
  function admit(terminalId, key) {
    const expected = terminalId == null ? null : keyOf(terminalId);
    const why = terminalId == null ? 'path' : !expected ? 'terminal' : !sameKey(expected, key) ? 'key' : null;
    if (why) counts.refused[why]++;
    return !why;
  }

  // body is null when it was over the size limit: the event still counts, from the URL alone, with no payload.
  function take(terminalId, event, body) {
    let payload = {};
    if (body === null) counts.oversize++;
    else {
      try { payload = JSON.parse(body); } catch { counts.unparsable++; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
    }
    const at = lastEventAt = now();
    counts.received++; counts.events[event] = (counts.events[event] || 0) + 1;
    const hookEvent = { seq: ++seq, terminalId, event, at, sessionId: text(payload.session_id), transcriptPath: text(payload.transcript_path),
      promptId: text(payload.prompt_id) || null, toolUseId: text(payload.tool_use_id) || null, agentId: text(payload.agent_id) || null,
      payload: subset(payload) };
    try { Promise.resolve(deliver(hookEvent)).catch(() => { counts.failed++; }); } catch { counts.failed++; }
  }

  // What main has to tell the session with the owner's next prompt (a mode switch), taken once; null for every other event.
  const note = (terminalId, event) => event === 'UserPromptSubmit' ? noteOf(terminalId) ?? null : null;

  return { admit, take, note, abort: () => { counts.aborted++; }, stats: () => ({ ...structuredClone(counts), lastEventAt }) };
}

module.exports = { createHookIngest };
