// A Claude Code terminal's session machine (C-4): the hooks, the transcript reads and the screen facts are its signals,
// and reduce(state, signal) → { state, effects } is pure. A signal that changes nothing returns the very state it was
// given, so the caller knows to publish nothing. Phase only moves forward within a prompt: a repeated, reordered or late
// signal, or one of an old epoch, never takes it back.
//
// Signals (`at` is main's clock, or the hook's send time on an async command channel):
//   start    { at, prompt, local }                    UserPromptSubmit of an owner prompt (local: a local slash command)
//   stop     { at, prompt, failed }                   Stop, or StopFailure when failed
//   attention{ at, prompt, notice, dialog, async }    PermissionRequest, Elicitation or an attention Notification
//   progress { at, prompt, async, agent }             a tool hook; agent: a sub-agent's own hook
//   session  { at, claudeSession, compact }           SessionStart; end { at } is SessionEnd
//   subagent { at, signal }                           C-15 sub-agent signal, passed through as an effect
//   record   { at, state }                            a transcript snapshot: working, complete or interrupted
//   screen   { at, terminalSession, revision, inputPresent, busy, dialog, menu, queueShown, draft }
//   settled  { at, queued, background }               the transcript read after a Stop: CompletionWork's queue and work
// Every hook signal may carry claudeSession; one from another Claude session than the epoch's changes nothing.
// Effects: { type: 'subagent', signal } and { type: 'completion', turn }.
const KEPT = 32;
const remember = (list, value) => value == null || list.includes(value) ? list : [...list, value].slice(-KEPT);
const ended = state => ({ ...state, phase: state.queue > 0 ? 'stopping' : 'ready', ended: remember(state.ended, state.prompt), dialog: null, busySeen: false });
const toolAt = (state, prompt) => state.toolAt.find(([id]) => id === prompt)?.[1] ?? 0;

function createSessionMachine({ terminalSession = null, claudeSession = null, launch = 0 } = {}) {
  return { epoch: { terminalSession, claudeSession, launch }, phase: 'starting', turn: 0, prompt: null, promptAt: 0,
    prompts: [], ended: [], toolAt: [], local: false, queue: 0, background: false, dialog: null, menu: false, screen: -1, busySeen: false,
    endedAt: 0, pending: null, completed: null };
}

function stale(state, signal) {
  const { epoch } = state;
  return signal.at < epoch.launch || state.phase === 'exited' && signal.type !== 'session'
    || signal.terminalSession !== undefined && signal.terminalSession !== epoch.terminalSession
    || signal.type !== 'session' && !!signal.claudeSession && !!epoch.claudeSession && signal.claudeSession !== epoch.claudeSession;
}

// A prompt first seen in a hook other than its UserPromptSubmit is a dequeued one, now the newest: it runs no
// UserPromptSubmit. One dated before the newest prompt began is an async hook of an older prompt arriving late, and a
// sub-agent's own hook never names the parent's turn. Returns null for a prompt that is neither the newest nor known.
function sight(state, { prompt, at, agent }) {
  if (!prompt || agent || state.prompts.includes(prompt)) return state;
  if (at < state.promptAt) return null;
  return { ...state, prompts: remember(state.prompts, prompt), prompt, promptAt: at, phase: 'working', queue: Math.max(0, state.queue - 1),
    dialog: null, busySeen: false, local: false };
}

function hook(state, signal) {
  const { prompt, at } = signal;
  if (signal.type === 'start') {
    // A finished prompt, an older known one, or an unknown one dated before the newest began is late.
    if (prompt && (state.ended.includes(prompt) || prompt !== state.prompt && (state.prompts.includes(prompt) || at < state.promptAt))) return null;
    // A prompt sent while Claude works is queued: its UserPromptSubmit carries the running prompt's id.
    const queued = !signal.local && !!prompt && prompt === state.prompt && state.phase === 'working';
    const next = { ...state, prompts: remember(state.prompts, prompt), local: !!signal.local, turn: signal.local ? state.turn : state.turn + 1 };
    return queued ? { ...next, queue: state.queue + 1 }
      : { ...next, prompt: prompt ?? state.prompt, promptAt: at, phase: 'working', queue: 0, background: false, dialog: null, busySeen: false, pending: null };
  }
  const seen = sight(state, signal);
  if (!seen) return null;
  if (signal.type === 'stop') {
    if (prompt && prompt !== seen.prompt) return null;
    // Only the newest prompt's Stop of an owner round not yet completed can lead to a completion, once it has settled.
    const pending = signal.failed || seen.local || seen.completed === seen.turn ? null : seen.turn;
    return { ...ended(seen), local: false, endedAt: Math.max(seen.endedAt, at), pending };
  }
  // Async command hooks arrive out of order: a hook of a prompt whose Stop was applied, or a permission notice older
  // than a tool hook of its prompt (the dialog it announced was answered), changes nothing.
  if (signal.async && prompt && (state.ended.includes(prompt) || signal.type === 'attention' && signal.notice && at < toolAt(state, prompt))) return null;
  if (signal.type === 'attention') return { ...seen, dialog: signal.dialog || 'permission' };
  return prompt ? { ...seen, toolAt: [...seen.toolAt.filter(([id]) => id !== prompt), [prompt, Math.max(at, toolAt(seen, prompt))]].slice(-KEPT) } : { ...seen };
}

// The screen is a fallback for the one transition no hook reports: Esc interrupts a turn without a Stop. A turn whose
// working line was seen and is gone again, with the input shown and no dialog, has ended. A frame drawn before the
// working line ever appeared proves nothing, so a turn that never showed it ends through Stop or the transcript.
function screen(state, signal) {
  if (!Number.isSafeInteger(signal.revision) || signal.revision <= state.screen) return null;
  const next = { ...state, screen: signal.revision, menu: !!signal.menu };
  if (!['working', 'stopping'].includes(state.phase)) return next;
  if (signal.busy) return { ...next, busySeen: true };
  if (!state.busySeen || signal.dialog || !signal.inputPresent) return next;
  return { ...ended(next), queue: 0, phase: 'ready', endedAt: Math.max(state.endedAt, signal.at) };
}

// The transcript ends a turn (an interrupt writes a record and runs no hook) and can start one before its prompt hook
// lands (a command hook trails the transcript), but a record dated before the last turn ended is late.
function record(state, signal) {
  if (signal.state === 'working') return state.endedAt && signal.at <= state.endedAt ? null : { ...state, phase: 'working' };
  if (!['complete', 'interrupted'].includes(signal.state) || state.phase !== 'working') return { ...state };
  return { ...ended(state), endedAt: Math.max(state.endedAt, signal.at) };
}

function reduce(state, signal) {
  if (!signal || stale(state, signal)) return { state, effects: [] };
  if (signal.type === 'subagent') return { state, effects: [{ type: 'subagent', signal: signal.signal }] };
  if (signal.type === 'settled') {
    if (state.pending == null || state.pending !== state.turn) return { state, effects: [] };
    const blocked = signal.queued || state.queue > 0 || signal.background;
    return { state: { ...state, pending: null, background: !!signal.background, ...(blocked ? {} : { completed: state.turn }) },
      effects: blocked ? [] : [{ type: 'completion', turn: state.turn }] };
  }
  let next;
  if (signal.type === 'session') {
    const fresh = signal.claudeSession !== state.epoch.claudeSession;
    const phase = signal.compact && state.phase === 'working' ? 'working' : 'ready';
    next = fresh ? { ...createSessionMachine({ ...state.epoch, claudeSession: signal.claudeSession }), turn: state.turn, completed: state.completed, screen: state.screen, phase }
      : { ...state, phase };
  } else if (signal.type === 'end') next = { ...state, phase: 'exited', dialog: null, pending: null };
  else if (signal.type === 'screen') next = screen(state, signal);
  else if (signal.type === 'record') next = record(state, signal);
  else if (['start', 'stop', 'attention', 'progress'].includes(signal.type)) next = hook(state, signal);
  return { state: next || state, effects: [] };
}

// The machine's part of the published CliState. `open` names the dialog only while the state says waiting.
function cliFields(state, published) {
  const open = { ...(published === 'waiting' && state.dialog ? { [state.dialog]: true } : {}), ...(state.menu ? { menu: true } : {}) };
  return { phase: state.phase, turn: state.turn, queue: state.queue, background: state.background, open };
}

module.exports = { createSessionMachine, reduce, cliFields };
