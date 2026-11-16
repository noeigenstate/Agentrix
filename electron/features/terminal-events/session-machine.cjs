// A Claude Code terminal's session machine (C-4): the hooks, the transcript reads and the screen facts are its signals,
// and reduce(state, signal) → { state, effects } is pure. A signal the machine rejects returns the very state it was
// given; one it accepts returns a new state, even when no field changed, so the caller knows whether to act. Phase only
// moves forward within a prompt: a repeated, reordered or late signal, or one of an old epoch, never takes it back.
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
//   attach   { at, terminalSession }                  the renderer attached again: its frame revisions restart
//   confirm  { at, asking }                           the caller's timer: has the screen's idle stood long enough?
//   settled  { at, queued, background, blocked }      a Stop's round, asked (again) with CompletionWork's final gate
// Every hook signal may carry claudeSession; one from another Claude session than the epoch's changes nothing.
// Effects: { type: 'subagent', signal } and { type: 'completion', turn }.
const KEPT = 32;
// How long the screen must look idle, with no newer screen fact or hook, before a working turn's light goes idle. The
// working line animates while Claude works, so a frame without it that stands this long is no half-drawn frame.
const SCREEN_IDLE_MS = 1000;
const remember = (list, value) => value == null || list.includes(value) ? list : [...list, value].slice(-KEPT);
const quiet = { idleLooking: false, screenIdle: false };
const ended = state => ({ ...state, ...quiet, phase: state.queue > 0 ? 'stopping' : 'ready', ended: remember(state.ended, state.prompt), dialog: null, busySeen: false });
const toolAt = (state, prompt) => state.toolAt.find(([id]) => id === prompt)?.[1] ?? 0;

function createSessionMachine({ terminalSession = null, claudeSession = null, launch = 0 } = {}) {
  return { epoch: { terminalSession, claudeSession, launch }, phase: 'starting', turn: 0, prompt: null, promptAt: 0,
    prompts: [], ended: [], toolAt: [], local: false, queue: 0, dialog: null, menu: false,
    screen: -1, busy: false, busySeen: false, quietSince: 0, ...quiet, screenIdleAt: 0, endedAt: 0, pending: null, completed: null };
}

// A sub-agent's signal still counts after SessionEnd: its row was delivered under the session that just ended.
function stale(state, signal) {
  const { epoch } = state;
  return signal.at < epoch.launch || state.phase === 'exited' && !['session', 'subagent'].includes(signal.type)
    || signal.terminalSession !== undefined && signal.terminalSession !== epoch.terminalSession
    || signal.type !== 'session' && !!signal.claudeSession && !!epoch.claudeSession && signal.claudeSession !== epoch.claudeSession;
}

// A new turn starts with the working line as the screen last showed it: Claude draws it before its prompt hook lands.
const turnStart = state => ({ ...state, ...quiet, phase: 'working', dialog: null, busySeen: state.busy });

// A prompt first seen in a hook other than its UserPromptSubmit is a dequeued one, now the newest: it runs no
// UserPromptSubmit. One dated before the newest prompt began is an async hook of an older prompt arriving late, and a
// sub-agent's own hook never names the parent's turn. Returns null for a prompt that is neither the newest nor known.
function sight(state, { prompt, at, agent }) {
  if (!prompt || agent || state.prompts.includes(prompt)) return state;
  if (at < state.promptAt) return null;
  return { ...turnStart(state), prompts: remember(state.prompts, prompt), prompt, promptAt: at, queue: Math.max(0, state.queue - 1), local: false };
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
      : { ...turnStart(next), prompt: prompt ?? state.prompt, promptAt: at, queue: 0, pending: null };
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
  // Any hook of the turn shows it still runs: a screen idle so far was false, and only an idle frame drawn after this
  // hook can start the quiet again (a long tool call on a short card shows no working line, and no frame may come).
  const live = { ...seen, ...quiet, quietSince: Math.max(seen.quietSince, at) };
  if (signal.type === 'attention') return { ...live, dialog: signal.dialog || 'permission' };
  return prompt ? { ...live, toolAt: [...live.toolAt.filter(([id]) => id !== prompt), [prompt, Math.max(at, toolAt(live, prompt))]].slice(-KEPT) } : live;
}

// The screen is a fallback for the one transition no hook reports: Esc interrupts a turn without a Stop. A working turn
// whose working line was seen and is gone, with the input shown and no dialog, looks idle; once that has stood for
// SCREEN_IDLE_MS (confirm), the light goes idle, the turn stays open and any later sign of it brings the light back.
// It is the light alone: the round, its completion and every owner action wait for a Stop, the transcript or Esc.
function screen(state, signal) {
  if (!Number.isSafeInteger(signal.revision) || signal.revision <= state.screen) return null;
  const next = { ...state, screen: signal.revision, menu: !!signal.menu, busy: !!signal.busy, quietSince: Math.max(state.quietSince, signal.at), idleLooking: false };
  if (state.phase !== 'working') return next;
  if (signal.busy) return { ...next, busySeen: true, screenIdle: false };
  // Once confirmed, only the working line, a hook or a newer record takes the idle back (a menu opened after Esc does not).
  return { ...next, idleLooking: !state.screenIdle && state.busySeen && !signal.dialog && !!signal.inputPresent };
}

// A permission or question the CLI is asking (asking: the terminal's waiting notice stands) is never confirmed away.
function confirm(state, signal) {
  if (signal.asking || state.phase !== 'working' || !state.idleLooking || signal.at - state.quietSince < SCREEN_IDLE_MS) return null;
  return { ...state, idleLooking: false, screenIdle: true, screenIdleAt: signal.at };
}

// The transcript ends a turn (an interrupt writes a record and runs no hook) and can start one before its prompt hook
// lands (a command hook trails the transcript), but a record dated before the last turn ended is late. A working record
// dated after a screen idle shows the turn still runs.
function record(state, signal) {
  const quietSince = Math.max(state.quietSince, signal.at);
  if (signal.state === 'working') {
    if (state.endedAt && signal.at < state.endedAt) return null;
    const revived = state.screenIdle && signal.at > state.screenIdleAt;
    return { ...(state.phase === 'working' ? state : turnStart(state)), quietSince, ...(revived ? quiet : {}) };
  }
  if (!['complete', 'interrupted'].includes(signal.state) || state.phase !== 'working') return { ...state, quietSince };
  return { ...ended(state), endedAt: Math.max(state.endedAt, signal.at) };
}

function reduce(state, signal) {
  if (!signal || stale(state, signal)) return { state, effects: [] };
  if (signal.type === 'subagent') return { state, effects: [{ type: 'subagent', signal: signal.signal }] };
  if (signal.type === 'settled') {
    if (state.pending == null || state.pending !== state.turn) return { state, effects: [] };
    // The transcript's queue is the authority here: a queued message Claude absorbed mid-turn or dropped runs no hook.
    // A held round stays pending until CompletionWork's final gate agrees, even after its queue and work clear.
    const blocked = signal.blocked || signal.queued || signal.background;
    return { state: { ...state, queue: signal.queued ? state.queue : 0, ...(blocked ? {} : { pending: null, completed: state.turn }) },
      effects: blocked ? [] : [{ type: 'completion', turn: state.turn }] };
  }
  let next;
  if (signal.type === 'session') {
    const fresh = signal.claudeSession !== state.epoch.claudeSession;
    const phase = signal.compact && state.phase === 'working' ? 'working' : 'ready';
    next = fresh ? { ...createSessionMachine({ ...state.epoch, claudeSession: signal.claudeSession }), turn: state.turn, completed: state.completed, screen: state.screen, phase }
      : { ...state, ...quiet, phase };
  } else if (signal.type === 'end') next = { ...state, ...quiet, phase: 'exited', dialog: null, pending: null };
  else if (signal.type === 'attach') next = { ...state, screen: -1 };
  else if (signal.type === 'screen') next = screen(state, signal);
  else if (signal.type === 'confirm') next = confirm(state, signal);
  else if (signal.type === 'record') next = record(state, signal);
  else if (['start', 'stop', 'attention', 'progress'].includes(signal.type)) next = hook(state, signal);
  return { state: next || state, effects: [] };
}

// The machine's part of the published CliState; `background` is CompletionWork's, as the caller reads it at publish
// time. `open` names the dialog only while the state says waiting, and
// `screenIdle` marks a working turn whose light the screen alone turned idle: the state itself stays working, so no
// reader that acts for the owner (a run-mode switch, a worker's intervention) takes it for idle.
function cliFields(state, published, background) {
  const open = { ...(published === 'waiting' && state.dialog ? { [state.dialog]: true } : {}), ...(state.menu ? { menu: true } : {}) };
  return { phase: state.phase, turn: state.turn, queue: state.queue, background, open, ...(state.screenIdle ? { screenIdle: true } : {}) };
}

module.exports = { createSessionMachine, reduce, cliFields, SCREEN_IDLE_MS };
